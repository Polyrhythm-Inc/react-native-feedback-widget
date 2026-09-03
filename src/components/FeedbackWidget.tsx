import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { FeedbackService } from '../services/feedback';
import { AnnotationEditor } from './AnnotationEditor';
import { SimpleFeedbackPanel } from './SimpleFeedbackPanel';
import { resolveFeedbackWidgetVariant } from '../utils/feedbackWidgetMode';

// Module-scope flag: once the simple-mode panel's switch gesture fires, the
// full widget stays unlocked for the rest of the JS session (mirrors the
// web version's sessionStorage-backed flag, without persisting to disk).
let simpleModeUnlockedToFull = false;

type FeedbackState =
  | 'idle'
  | 'capturing'
  | 'login'
  | 'annotating'
  | 'preview'
  | 'sending'
  | 'success';

interface FeedbackWidgetProps {
  apiUrl: string;
  projectId: string;
  widgetProjectId?: string;
  authUrl?: string;
  appTitle?: string;
  mode?: 'simple' | 'full';
  /**
   * When `false`, skips automatic screenshot capture (and annotation) on FAB
   * tap / post-login, letting users submit comment-only feedback. Defaults
   * to `true` to preserve existing behavior.
   */
  enableScreenshot?: boolean;
  children: React.ReactNode;
}

/**
 * Public entry point. Defaults to the full feedback experience (screenshot
 * capture, annotation, optional login) so existing consumers are unaffected.
 * `mode="simple"` renders the lightweight good/bad rating panel instead,
 * until its header-title switch gesture (5 taps within 2s) unlocks the full
 * widget for the rest of the session.
 */
export function FeedbackWidget({
  mode = 'full',
  ...rest
}: FeedbackWidgetProps) {
  const { apiUrl, projectId, authUrl, appTitle, children } = rest;
  const [switchedToFull, setSwitchedToFull] = useState(
    simpleModeUnlockedToFull,
  );
  const showSimplePanel =
    resolveFeedbackWidgetVariant(mode, switchedToFull) === 'simple';

  useEffect(() => {
    if (showSimplePanel) {
      FeedbackService.configure({ apiUrl, projectId, authUrl, appTitle });
    }
  }, [showSimplePanel, apiUrl, projectId, authUrl, appTitle]);

  if (showSimplePanel) {
    return (
      <SimpleFeedbackPanel
        projectId={projectId}
        onSwitchToFull={() => {
          simpleModeUnlockedToFull = true;
          setSwitchedToFull(true);
        }}
      >
        {children}
      </SimpleFeedbackPanel>
    );
  }

  return <FullFeedbackWidget {...rest} />;
}

function FullFeedbackWidget({
  apiUrl,
  projectId,
  widgetProjectId,
  authUrl,
  appTitle,
  enableScreenshot = true,
  children,
}: Omit<FeedbackWidgetProps, 'mode'>) {
  const viewShotRef = useRef<ViewShot>(null);
  const [state, setState] = useState<FeedbackState>('idle');
  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [widgetFeedbackMode, setWidgetFeedbackMode] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const activeProjectId =
    widgetFeedbackMode && widgetProjectId ? widgetProjectId : projectId;

  useEffect(() => {
    FeedbackService.configure({ apiUrl, projectId, authUrl, appTitle });
  }, [apiUrl, projectId, authUrl, appTitle]);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      return await captureRef(viewShotRef, {
        format: 'png',
        quality: 0.8,
        result: 'base64',
      });
    } catch {
      return null;
    }
  }, []);

  const handleFabPress = useCallback(async () => {
    if (FeedbackService.requiresAuth && !FeedbackService.isAuthenticated) {
      setState('login');
      return;
    }

    if (!enableScreenshot) {
      setScreenshotBase64(null);
      setState('preview');
      return;
    }

    setState('capturing');
    const uri = await captureScreenshot();
    if (uri) {
      setScreenshotBase64(uri);
      setState('preview');
    } else {
      setState('idle');
      Alert.alert('Error', 'Failed to capture screenshot');
    }
  }, [captureScreenshot, enableScreenshot]);

  const handleLogin = useCallback(async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoginLoading(true);
    try {
      const error = await FeedbackService.login(email.trim(), password);
      if (error === null) {
        setEmail('');
        setPassword('');
        if (!enableScreenshot) {
          setScreenshotBase64(null);
          setState('preview');
        } else {
          setState('capturing');
          const uri = await captureScreenshot();
          if (uri) {
            setScreenshotBase64(uri);
            setState('preview');
          } else {
            setState('idle');
          }
        }
      } else {
        Alert.alert('Login Failed', error);
      }
    } catch {
      Alert.alert('Error', 'Login failed. Please try again.');
    } finally {
      setLoginLoading(false);
    }
  }, [email, password, captureScreenshot, enableScreenshot]);

  const handleAnnotate = useCallback(() => {
    setState('annotating');
  }, []);

  const handleAnnotationDone = useCallback((annotatedBase64: string) => {
    setScreenshotBase64(annotatedBase64);
    setState('preview');
  }, []);

  const handleAnnotationCancel = useCallback(() => {
    setState('preview');
  }, []);

  const handleSend = useCallback(async () => {
    if (!comment.trim()) {
      Alert.alert('Error', 'Please enter a comment');
      return;
    }

    setState('sending');
    try {
      let uploadedDataId: string | undefined;
      if (screenshotBase64) {
        uploadedDataId = await FeedbackService.uploadScreenshot(
          screenshotBase64,
        );
      }
      await FeedbackService.submitFeedback(
        comment.trim(),
        uploadedDataId,
        activeProjectId,
      );

      setState('success');
      successTimeoutRef.current = setTimeout(() => {
        setState('idle');
        setComment('');
        setScreenshotBase64(null);
      }, 1500);
    } catch (e) {
      setState('preview');
      Alert.alert(
        'Error',
        e instanceof Error ? e.message : 'Failed to send feedback',
      );
    }
  }, [comment, screenshotBase64, activeProjectId]);

  const handleCancel = useCallback(() => {
    setState('idle');
    setComment('');
    setScreenshotBase64(null);
  }, []);

  const renderLoginForm = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Login to Send Feedback</Text>
        <TouchableOpacity onPress={handleCancel}>
          <Text style={styles.closeButton}>✕</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={styles.loginInput}
        placeholder="Email"
        placeholderTextColor="#666"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loginLoading}
      />

      <TextInput
        style={styles.loginInput}
        placeholder="Password"
        placeholderTextColor="#666"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        editable={!loginLoading}
      />

      <TouchableOpacity
        style={[styles.sendButton, loginLoading && styles.sendButtonDisabled]}
        onPress={handleLogin}
        disabled={loginLoading}
      >
        {loginLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.sendButtonText}>Login</Text>
        )}
      </TouchableOpacity>
    </>
  );

  const renderFeedbackForm = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Send Feedback</Text>
        <TouchableOpacity onPress={handleCancel}>
          <Text style={styles.closeButton}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Widget feedback mode toggle */}
      {widgetProjectId && (
        <TouchableOpacity
          style={[
            styles.modeToggle,
            widgetFeedbackMode && styles.modeToggleActive,
          ]}
          onPress={() => setWidgetFeedbackMode((prev) => !prev)}
        >
          <Text
            style={[
              styles.modeToggleText,
              widgetFeedbackMode && styles.modeToggleTextActive,
            ]}
          >
            {widgetFeedbackMode ? 'Report app issue' : 'Report widget issue'}
          </Text>
        </TouchableOpacity>
      )}

      {/* ProjectId display */}
      <View style={styles.projectIdRow}>
        <Text style={styles.projectIdLabel}>Project: </Text>
        <Text style={styles.projectIdValue}>{activeProjectId}</Text>
      </View>

      {screenshotBase64 && (
        <TouchableOpacity onPress={handleAnnotate} activeOpacity={0.8}>
          <Image
            source={{
              uri: `data:image/png;base64,${screenshotBase64}`,
            }}
            style={styles.screenshotPreview}
            resizeMode="contain"
          />
          <View style={styles.annotateOverlay}>
            <Text style={styles.annotateText}>Tap to annotate</Text>
          </View>
        </TouchableOpacity>
      )}

      <TextInput
        style={styles.commentInput}
        placeholder="Describe the issue or suggestion..."
        placeholderTextColor="#666"
        value={comment}
        onChangeText={setComment}
        multiline
        numberOfLines={4}
        editable={state === 'preview'}
      />

      <TouchableOpacity
        style={[
          styles.sendButton,
          state === 'sending' && styles.sendButtonDisabled,
        ]}
        onPress={handleSend}
        disabled={state === 'sending'}
      >
        {state === 'sending' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.sendButtonText}>Send</Text>
        )}
      </TouchableOpacity>
    </>
  );

  return (
    <View style={styles.container}>
      <ViewShot ref={viewShotRef} style={styles.container}>
        {children}
      </ViewShot>

      {state === 'idle' && (
        <TouchableOpacity
          style={styles.fab}
          onPress={handleFabPress}
          activeOpacity={0.8}
        >
          <Text style={styles.fabText}>💬</Text>
        </TouchableOpacity>
      )}

      {/* Annotation editor (full-screen) */}
      <Modal
        visible={state === 'annotating'}
        animationType="fade"
        onRequestClose={handleAnnotationCancel}
      >
        {screenshotBase64 && (
          <AnnotationEditor
            screenshotBase64={screenshotBase64}
            onDone={handleAnnotationDone}
            onCancel={handleAnnotationCancel}
          />
        )}
      </Modal>

      {/* Feedback form modal */}
      <Modal
        visible={['login', 'preview', 'sending', 'success'].includes(state)}
        transparent
        animationType="slide"
        onRequestClose={handleCancel}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContent}>
            {state === 'success' ? (
              <View style={styles.successContainer}>
                <Text style={styles.successText}>Feedback sent!</Text>
              </View>
            ) : state === 'login' ? (
              renderLoginForm()
            ) : (
              renderFeedbackForm()
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 100,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#7c5cbf',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  fabText: {
    fontSize: 24,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  closeButton: {
    fontSize: 20,
    color: '#888',
    padding: 4,
  },
  loginInput: {
    backgroundColor: '#0d0d1a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333',
  },
  screenshotPreview: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginBottom: 16,
    backgroundColor: '#0d0d1a',
  },
  annotateOverlay: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  annotateText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  commentInput: {
    backgroundColor: '#0d0d1a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  sendButton: {
    backgroundColor: '#7c5cbf',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modeToggle: {
    borderWidth: 1,
    borderColor: '#555',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  modeToggleActive: {
    backgroundColor: '#7c5cbf',
    borderColor: '#7c5cbf',
  },
  modeToggleText: {
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
  },
  modeToggleTextActive: {
    color: '#fff',
  },
  projectIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  projectIdLabel: {
    fontSize: 11,
    color: '#666',
  },
  projectIdValue: {
    fontSize: 11,
    color: '#999',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  successContainer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  successText: {
    fontSize: 18,
    color: '#4caf50',
    fontWeight: '600',
  },
});
