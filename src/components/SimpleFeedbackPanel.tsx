import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { FeedbackService } from '../services/feedback';
import { createTapSwitchGesture } from '../utils/tapSwitchGesture';

type Rating = 'good' | 'bad';
type SubmitStatus = 'idle' | 'sending' | 'success' | 'error';

// Switch gesture: 5 taps on the panel header title, each within 2s of the
// previous one, switches to the full-feature widget. Mirrors the web
// simple-widget.ts behavior.
const SWITCH_TAP_THRESHOLD = 5;
const SWITCH_TAP_INTERVAL_MS = 2000;
const SUCCESS_AUTO_CLOSE_MS = 2000;

interface SimpleFeedbackPanelProps {
  projectId: string;
  children: React.ReactNode;
  onSwitchToFull: () => void;
}

export function SimpleFeedbackPanel({
  projectId,
  children,
  onSwitchToFull,
}: SimpleFeedbackPanelProps) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<Rating | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tapGestureRef = useRef(
    createTapSwitchGesture(
      SWITCH_TAP_THRESHOLD,
      SWITCH_TAP_INTERVAL_MS,
      onSwitchToFull,
    ),
  );

  useEffect(() => {
    const tapGesture = tapGestureRef.current;
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
      tapGesture.dispose();
    };
  }, []);

  const resetForm = useCallback(() => {
    setRating(null);
    setReason('');
    setStatus('idle');
    setStatusMessage('');
  }, []);

  const handleOpen = useCallback(() => setOpen(true), []);

  const handleClose = useCallback(() => {
    setOpen(false);
    resetForm();
  }, [resetForm]);

  const handleSelectRating = useCallback((next: Rating) => {
    setRating(next);
    setStatus('idle');
    setStatusMessage('');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!rating) {
      setStatus('error');
      setStatusMessage('Please select a rating first');
      return;
    }

    setStatus('sending');
    setStatusMessage('Sending...');

    try {
      const trimmedReason = reason.trim();
      await FeedbackService.trackEvent({
        eventType: 'rating',
        projectId,
        rating,
        reason: trimmedReason ? trimmedReason : undefined,
      });

      setStatus('success');
      setStatusMessage('Thank you for your feedback!');
      closeTimeoutRef.current = setTimeout(() => {
        setOpen(false);
        resetForm();
      }, SUCCESS_AUTO_CLOSE_MS);
    } catch (e) {
      setStatus('error');
      setStatusMessage(
        e instanceof Error ? e.message : 'Failed to send feedback',
      );
    }
  }, [rating, reason, projectId, resetForm]);

  const handleHeaderTitlePress = useCallback(() => {
    tapGestureRef.current.registerTap();
  }, []);

  return (
    <View style={styles.container}>
      {children}

      {!open && (
        <TouchableOpacity
          style={styles.fab}
          onPress={handleOpen}
          activeOpacity={0.8}
        >
          <Text style={styles.fabText}>💬</Text>
        </TouchableOpacity>
      )}

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={handleClose}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContent}>
            <View style={styles.header}>
              <TouchableOpacity onPress={handleHeaderTitlePress}>
                <Text style={styles.headerTitle}>Feedback</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleClose}>
                <Text style={styles.closeButton}>✕</Text>
              </TouchableOpacity>
            </View>

            {status === 'success' ? (
              <View style={styles.successContainer}>
                <Text style={styles.successText}>{statusMessage}</Text>
              </View>
            ) : (
              <>
                <View style={styles.ratingRow}>
                  <TouchableOpacity
                    style={[
                      styles.ratingButton,
                      rating === 'good' && styles.ratingButtonSelected,
                    ]}
                    onPress={() => handleSelectRating('good')}
                  >
                    <Text style={styles.ratingButtonText}>👍 Good</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.ratingButton,
                      rating === 'bad' && styles.ratingButtonSelected,
                    ]}
                    onPress={() => handleSelectRating('bad')}
                  >
                    <Text style={styles.ratingButtonText}>👎 Bad</Text>
                  </TouchableOpacity>
                </View>

                <TextInput
                  style={styles.reasonInput}
                  placeholder="Reason (optional)"
                  placeholderTextColor="#666"
                  value={reason}
                  onChangeText={setReason}
                  editable={status !== 'sending'}
                />

                {status !== 'idle' && !!statusMessage && (
                  <Text
                    style={[
                      styles.statusText,
                      status === 'error' && styles.statusTextError,
                    ]}
                  >
                    {statusMessage}
                  </Text>
                )}

                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    status === 'sending' && styles.sendButtonDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={status === 'sending'}
                >
                  {status === 'sending' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.sendButtonText}>Send</Text>
                  )}
                </TouchableOpacity>
              </>
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
  ratingRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  ratingButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#0d0d1a',
  },
  ratingButtonSelected: {
    borderColor: '#7c5cbf',
    backgroundColor: '#3a2d5c',
  },
  ratingButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  reasonInput: {
    backgroundColor: '#0d0d1a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333',
  },
  statusText: {
    fontSize: 13,
    color: '#4caf50',
    marginBottom: 12,
  },
  statusTextError: {
    color: '#ff5252',
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
  successContainer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  successText: {
    fontSize: 16,
    color: '#4caf50',
    fontWeight: '600',
  },
});
