import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  GestureResponderEvent,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import ViewShot, { captureRef } from 'react-native-view-shot';

// --- Types ---

type ToolType = 'pen' | 'arrow' | 'rect' | 'text';

interface Point {
  x: number;
  y: number;
}

interface PenAnnotation {
  type: 'pen';
  points: Point[];
  color: string;
}

interface ArrowAnnotation {
  type: 'arrow';
  start: Point;
  end: Point;
  color: string;
}

interface RectAnnotation {
  type: 'rect';
  origin: Point;
  size: { width: number; height: number };
  color: string;
}

interface TextAnnotation {
  type: 'text';
  position: Point;
  text: string;
  color: string;
}

type Annotation = PenAnnotation | ArrowAnnotation | RectAnnotation | TextAnnotation;

// --- Constants (matching Flutter version) ---

const STROKE_WIDTH = 3;
const ARROW_HEAD_SIZE = 14;
const TEXT_FONT_SIZE = 18;

const COLORS = [
  '#FF3B30', // red
  '#FF9500', // orange
  '#FFCC00', // yellow
  '#34C759', // green
  '#007AFF', // blue
  '#AF52DE', // purple
  '#FFFFFF', // white
  '#000000', // black
];

const TOOLS: { type: ToolType; label: string }[] = [
  { type: 'pen', label: '✏️' },
  { type: 'arrow', label: '➡️' },
  { type: 'rect', label: '⬜' },
  { type: 'text', label: '🔤' },
];

// --- Props ---

interface AnnotationEditorProps {
  screenshotBase64: string;
  onDone: (annotatedBase64: string) => void;
  onCancel: () => void;
}

export function AnnotationEditor({
  screenshotBase64,
  onDone,
  onCancel,
}: AnnotationEditorProps) {
  const insets = useSafeAreaInsets();
  const canvasRef = useRef<ViewShot>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [currentTool, setCurrentTool] = useState<ToolType>('pen');
  const [currentColor, setCurrentColor] = useState(COLORS[0]);
  const [drawingAnnotation, setDrawingAnnotation] = useState<Annotation | null>(
    null,
  );
  const [textInput, setTextInput] = useState<{
    position: Point;
    value: string;
  } | null>(null);
  const [canvasLayout, setCanvasLayout] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const getPoint = useCallback(
    (e: GestureResponderEvent): Point => {
      const { locationX, locationY } = e.nativeEvent;
      return { x: locationX, y: locationY };
    },
    [],
  );

  const handleTouchStart = useCallback(
    (e: GestureResponderEvent) => {
      if (textInput) return;
      const point = getPoint(e);

      switch (currentTool) {
        case 'pen':
          setDrawingAnnotation({
            type: 'pen',
            points: [point],
            color: currentColor,
          });
          break;
        case 'arrow':
          setDrawingAnnotation({
            type: 'arrow',
            start: point,
            end: point,
            color: currentColor,
          });
          break;
        case 'rect':
          setDrawingAnnotation({
            type: 'rect',
            origin: point,
            size: { width: 0, height: 0 },
            color: currentColor,
          });
          break;
        case 'text':
          setTextInput({ position: point, value: '' });
          break;
      }
    },
    [currentTool, currentColor, getPoint, textInput],
  );

  const handleTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      const point = getPoint(e);

      setDrawingAnnotation((prev) => {
        if (!prev) return prev;
        switch (prev.type) {
          case 'pen':
            // Mutate in place to avoid O(n) copy per frame
            prev.points.push(point);
            return { ...prev };
          case 'arrow':
            return { ...prev, end: point };
          case 'rect':
            return {
              ...prev,
              size: {
                width: point.x - prev.origin.x,
                height: point.y - prev.origin.y,
              },
            };
          default:
            return prev;
        }
      });
    },
    [getPoint],
  );

  const handleTouchEnd = useCallback(() => {
    if (drawingAnnotation) {
      setAnnotations((prev) => [...prev, drawingAnnotation]);
      setRedoStack([]);
      setDrawingAnnotation(null);
    }
  }, [drawingAnnotation]);

  const handleTextConfirm = useCallback(() => {
    if (textInput && textInput.value.trim()) {
      const annotation: TextAnnotation = {
        type: 'text',
        position: textInput.position,
        text: textInput.value.trim(),
        color: currentColor,
      };
      setAnnotations((prev) => [...prev, annotation]);
      setRedoStack([]);
    }
    setTextInput(null);
  }, [textInput, currentColor]);

  const handleUndo = useCallback(() => {
    setAnnotations((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((stack) => [...stack, last]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const last = stack[stack.length - 1];
      setAnnotations((prev) => [...prev, last]);
      return stack.slice(0, -1);
    });
  }, []);

  const handleDone = useCallback(async () => {
    try {
      const uri = await captureRef(canvasRef, {
        format: 'png',
        quality: 1.0,
        result: 'base64',
      });
      onDone(uri);
    } catch {
      onCancel();
    }
  }, [onDone, onCancel]);

  // --- Render helpers ---

  const renderAnnotation = useCallback(
    (annotation: Annotation, index: number) => {
      switch (annotation.type) {
        case 'pen':
          return renderPen(annotation, index);
        case 'arrow':
          return renderArrow(annotation, index);
        case 'rect':
          return renderRect(annotation, index);
        case 'text':
          return renderText(annotation, index);
      }
    },
    [],
  );

  const allAnnotations = useMemo(() => {
    const items = [...annotations];
    if (drawingAnnotation) items.push(drawingAnnotation);
    return items;
  }, [annotations, drawingAnnotation]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Annotate</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={handleUndo}
            disabled={annotations.length === 0}
            style={styles.headerButton}
          >
            <Text
              style={[
                styles.headerButtonText,
                annotations.length === 0 && styles.disabled,
              ]}
            >
              ↩
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleRedo}
            disabled={redoStack.length === 0}
            style={styles.headerButton}
          >
            <Text
              style={[
                styles.headerButtonText,
                redoStack.length === 0 && styles.disabled,
              ]}
            >
              ↪
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDone} style={styles.doneButton}>
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Canvas */}
      <View
        style={styles.canvasContainer}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setCanvasLayout({ width, height });
        }}
      >
        <ViewShot ref={canvasRef} style={styles.canvasInner}>
          <Image
            source={{ uri: `data:image/png;base64,${screenshotBase64}` }}
            style={styles.screenshotImage}
            resizeMode="contain"
          />
          {canvasLayout && (
            <View
              style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={handleTouchStart}
              onResponderMove={handleTouchMove}
              onResponderRelease={handleTouchEnd}
            >
              <Svg style={StyleSheet.absoluteFill}>
                {allAnnotations.map((a, i) => renderAnnotation(a, i))}
              </Svg>
            </View>
          )}
        </ViewShot>

        {/* Text input overlay */}
        {textInput && (
          <View
            style={[
              styles.textInputContainer,
              { left: textInput.position.x, top: textInput.position.y },
            ]}
          >
            <TextInput
              style={[styles.textInputField, { color: currentColor }]}
              value={textInput.value}
              onChangeText={(v) => setTextInput({ ...textInput, value: v })}
              onSubmitEditing={handleTextConfirm}
              onBlur={handleTextConfirm}
              autoFocus
              placeholder="Type text..."
              placeholderTextColor="#666"
            />
          </View>
        )}
      </View>

      {/* Toolbar */}
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.toolRow}>
          {TOOLS.map((tool) => (
            <TouchableOpacity
              key={tool.type}
              style={[
                styles.toolButton,
                currentTool === tool.type && styles.toolButtonActive,
              ]}
              onPress={() => setCurrentTool(tool.type)}
            >
              <Text style={styles.toolButtonText}>{tool.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.colorRow}>
          {COLORS.map((color) => (
            <TouchableOpacity
              key={color}
              onPress={() => setCurrentColor(color)}
              style={[
                styles.colorChip,
                { backgroundColor: color },
                currentColor === color && styles.colorChipActive,
              ]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

// --- SVG render functions ---

function renderPen(annotation: PenAnnotation, index: number) {
  if (annotation.points.length < 2) {
    const p = annotation.points[0];
    if (!p) return null;
    return (
      <Circle
        key={`pen-${index}`}
        cx={p.x}
        cy={p.y}
        r={STROKE_WIDTH / 2}
        fill={annotation.color}
      />
    );
  }

  const d = annotation.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`)
    .join(' ');

  return (
    <Path
      key={`pen-${index}`}
      d={d}
      stroke={annotation.color}
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

function renderArrow(annotation: ArrowAnnotation, index: number) {
  const { start, end, color } = annotation;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headAngle = Math.PI / 6;

  const head1 = {
    x: end.x - ARROW_HEAD_SIZE * Math.cos(angle - headAngle),
    y: end.y - ARROW_HEAD_SIZE * Math.sin(angle - headAngle),
  };
  const head2 = {
    x: end.x - ARROW_HEAD_SIZE * Math.cos(angle + headAngle),
    y: end.y - ARROW_HEAD_SIZE * Math.sin(angle + headAngle),
  };

  return (
    <React.Fragment key={`arrow-${index}`}>
      <Line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
      />
      <Line
        x1={end.x}
        y1={end.y}
        x2={head1.x}
        y2={head1.y}
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
      />
      <Line
        x1={end.x}
        y1={end.y}
        x2={head2.x}
        y2={head2.y}
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
      />
    </React.Fragment>
  );
}

function renderRect(annotation: RectAnnotation, index: number) {
  const { origin, size, color } = annotation;
  const x = size.width >= 0 ? origin.x : origin.x + size.width;
  const y = size.height >= 0 ? origin.y : origin.y + size.height;
  const w = Math.abs(size.width);
  const h = Math.abs(size.height);

  return (
    <Rect
      key={`rect-${index}`}
      x={x}
      y={y}
      width={w}
      height={h}
      stroke={color}
      strokeWidth={STROKE_WIDTH}
      fill="none"
    />
  );
}

function renderText(annotation: TextAnnotation, index: number) {
  return (
    <SvgText
      key={`text-${index}`}
      x={annotation.position.x}
      y={annotation.position.y}
      fill={annotation.color}
      fontSize={TEXT_FONT_SIZE}
      fontWeight="bold"
    >
      {annotation.text}
    </SvgText>
  );
}

// --- Styles ---

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headerButton: {
    padding: 8,
  },
  headerButtonText: {
    color: '#fff',
    fontSize: 20,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  doneButton: {
    backgroundColor: '#007AFF',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginLeft: 8,
  },
  doneButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.3,
  },
  canvasContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  canvasInner: {
    flex: 1,
  },
  screenshotImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  textInputContainer: {
    position: 'absolute',
    minWidth: 120,
  },
  textInputField: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: TEXT_FONT_SIZE,
    fontWeight: 'bold',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  toolbar: {
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toolRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    marginBottom: 12,
  },
  toolButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolButtonActive: {
    backgroundColor: '#007AFF',
  },
  toolButtonText: {
    fontSize: 20,
  },
  colorRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  colorChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  colorChipActive: {
    borderWidth: 2.5,
    borderColor: '#007AFF',
  },
});
