import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import type {
  Face,
  FaceDetectionOptions,
} from 'react-native-vision-camera-face-detector';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import { Worklets } from 'react-native-worklets-core';

type ScanStatus =
  | 'Searching target...'
  | 'Move closer'
  | 'Face forward'
  | 'Locking...'
  | 'Target locked';

type FaceBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const REQUIRED_STABLE_MS = 1000;
const MAX_ANGLE = 14;
const MIN_FACE_WIDTH_RATIO = 0.3;
const MAX_CENTER_OFFSET_RATIO = 0.16;

export function CameraScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  const device = useCameraDevice(cameraFacing);
  const camera = useRef<Camera>(null);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [status, setStatus] = useState<ScanStatus>('Searching target...');
  const [faceBounds, setFaceBounds] = useState<FaceBounds | null>(null);
  const stableSince = useRef<number | null>(null);
  const lastStatus = useRef<ScanStatus>('Searching target...');
  const scanProgress = useRef(new Animated.Value(0)).current;
  const lockPulse = useRef(new Animated.Value(0)).current;
  const threatProgress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Camera.getCameraPermissionStatus();
    setPermissionChecked(true);
  }, []);

  const detectionOptions = useMemo<FaceDetectionOptions>(() => ({
    performanceMode: 'fast',
    landmarkMode: 'none',
    contourMode: 'none',
    classificationMode: 'none',
    minFaceSize: 0.15,
    trackingEnabled: true,
    autoMode: true,
    windowWidth: screenWidth,
    windowHeight: screenHeight,
    cameraFacing,
  }), [cameraFacing, screenHeight, screenWidth]);
  const { detectFaces, stopListeners } = useFaceDetector(detectionOptions);

  useEffect(() => stopListeners, [stopListeners]);

  useEffect(() => {
    stableSince.current = null;
    lastStatus.current = 'Searching target...';
    setStatus('Searching target...');
    setFaceBounds(null);
  }, [cameraFacing]);

  const hasFace = faceBounds !== null;
  const isLocked = status === 'Target locked';

  useEffect(() => {
    if (!hasFace || isLocked) {
      scanProgress.stopAnimation();
      scanProgress.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(scanProgress, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.linear),
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [hasFace, isLocked, scanProgress]);

  useEffect(() => {
    if (status !== 'Locking...') {
      lockPulse.stopAnimation();
      Animated.timing(lockPulse, {
        toValue: isLocked ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(lockPulse, {
          toValue: 1,
          duration: 320,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(lockPulse, {
          toValue: 0,
          duration: 320,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [isLocked, lockPulse, status]);

  useEffect(() => {
    const progressByStatus: Record<ScanStatus, number> = {
      'Searching target...': 0,
      'Move closer': 0.25,
      'Face forward': 0.5,
      'Locking...': 0.78,
      'Target locked': 1,
    };

    Animated.timing(threatProgress, {
      toValue: progressByStatus[status],
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [status, threatProgress]);

  const updateStatus = useCallback((nextStatus: ScanStatus) => {
    if (lastStatus.current !== nextStatus) {
      lastStatus.current = nextStatus;
      setStatus(nextStatus);
    }
  }, []);

  const handleFacesDetected = useCallback((faces: Face[]) => {
    const face = faces[0];
    if (!face) {
      stableSince.current = null;
      setFaceBounds(null);
      updateStatus('Searching target...');
      return;
    }

    const bounds = face.bounds as FaceBounds;
    setFaceBounds(bounds);

    const faceIsLargeEnough = bounds.width / screenWidth >= MIN_FACE_WIDTH_RATIO;
    if (!faceIsLargeEnough) {
      stableSince.current = null;
      updateStatus('Move closer');
      return;
    }

    const faceCenterX = bounds.x + bounds.width / 2;
    const faceCenterY = bounds.y + bounds.height / 2;
    const centerOffsetX = Math.abs(faceCenterX - screenWidth / 2) / screenWidth;
    const centerOffsetY = Math.abs(faceCenterY - screenHeight / 2) / screenHeight;
    const yaw = Math.abs(face.yawAngle ?? 0);
    const roll = Math.abs(face.rollAngle ?? 0);
    const faceIsCentered = centerOffsetX <= MAX_CENTER_OFFSET_RATIO
      && centerOffsetY <= MAX_CENTER_OFFSET_RATIO;
    const faceIsForward = yaw <= MAX_ANGLE && roll <= MAX_ANGLE;

    if (!faceIsCentered || !faceIsForward) {
      stableSince.current = null;
      updateStatus('Face forward');
      return;
    }

    const now = Date.now();
    stableSince.current ??= now;
    if (now - stableSince.current >= REQUIRED_STABLE_MS) {
      updateStatus('Target locked');
      return;
    }

    updateStatus('Locking...');
  }, [screenHeight, screenWidth, updateStatus]);

  const reportFacesToJS = useMemo(
    () => Worklets.createRunOnJS(handleFacesDetected),
    [handleFacesDetected],
  );
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    runAtTargetFps(8, () => {
      'worklet';
      reportFacesToJS(detectFaces(frame));
    });
  }, [detectFaces, reportFacesToJS]);

  if (!permissionChecked) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#7ef9c6" size="large" />
        <Text style={styles.message}>Loading camera...</Text>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.permissionTitle}>Camera access required</Text>
        <Text style={styles.permissionCopy}>
          BountyFace needs camera access to detect a face on this device.
        </Text>
        <Pressable
          accessibilityRole="button"
          style={styles.permissionButton}
          onPress={() => requestPermission()}
        >
          <Text style={styles.permissionButtonText}>Allow camera</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Camera unavailable</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        frameProcessor={frameProcessor}
        pixelFormat="yuv"
      />

      <SafeAreaView pointerEvents="box-none" style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.brand}>BOUNTYFACE</Text>
          <View style={styles.headerActions}>
            <View style={[styles.liveDot, isLocked && styles.lockedDot]} />
            <Pressable
              accessibilityLabel={cameraFacing === 'back' ? '切換為自拍鏡頭' : '切換為後鏡頭'}
              accessibilityRole="button"
              hitSlop={8}
              style={({ pressed }) => [styles.flipButton, pressed && styles.flipButtonPressed]}
              onPress={() => setCameraFacing((current) => current === 'back' ? 'front' : 'back')}
            >
              <Text style={styles.flipButtonText}>
                {cameraFacing === 'back' ? '自拍' : '後鏡頭'}
              </Text>
            </Pressable>
          </View>
        </View>

        {faceBounds && (
          <Animated.View
            style={[
              styles.faceBox,
              isLocked && styles.faceBoxLocked,
              {
                left: faceBounds.x,
                top: faceBounds.y,
                width: faceBounds.width,
                height: faceBounds.height,
                opacity: lockPulse.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.82, 1],
                }),
                transform: [{
                  scale: lockPulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, isLocked ? 1.015 : 1.035],
                  }),
                }],
              },
            ]}
          >
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
            {!isLocked && (
              <Animated.View
                style={[
                  styles.scanLine,
                  {
                    transform: [{
                      translateY: scanProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [2, Math.max(2, faceBounds.height - 4)],
                      }),
                    }],
                  },
                ]}
              />
            )}
            {isLocked && (
              <View style={styles.lockBadge}>
                <Text style={styles.lockBadgeText}>LOCK</Text>
              </View>
            )}
          </Animated.View>
        )}

        <View style={styles.statusPanel}>
          <View style={styles.statusHeading}>
            <View>
              <Text style={styles.statusLabel}>FACE ACQUISITION</Text>
              <Text style={[styles.status, isLocked && styles.statusLocked]}>{status}</Text>
            </View>
            <Text style={[styles.readyState, isLocked && styles.readyStateLocked]}>
              {isLocked ? 'READY' : 'SCANNING'}
            </Text>
          </View>

          <View style={styles.threatPanel}>
            <View style={styles.threatHeader}>
              <Text style={styles.threatLabel}>THREAT SIGNAL</Text>
              <Text style={styles.threatValue}>{isLocked ? '100%' : 'CALIBRATING'}</Text>
            </View>
            <View style={styles.threatTrack}>
              <Animated.View
                style={[
                  styles.threatFill,
                  isLocked && styles.threatFillLocked,
                  {
                    width: threatProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
              />
            </View>
            <View style={styles.metricsRow}>
              <Text style={styles.metric}>FACE {hasFace ? 'ON' : '--'}</Text>
              <Text style={styles.metric}>ALIGN {status === 'Face forward' ? 'ADJUST' : hasFace ? 'OK' : '--'}</Text>
              <Text style={styles.metric}>LOCK {isLocked ? 'YES' : 'NO'}</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#050807' },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: '#050807',
  },
  message: { marginTop: 16, color: '#d8e2de', fontSize: 16 },
  permissionTitle: { color: '#ffffff', fontSize: 24, fontWeight: '700' },
  permissionCopy: {
    maxWidth: 320,
    marginTop: 12,
    color: '#aebbb6',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 28,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 6,
    backgroundColor: '#7ef9c6',
  },
  permissionButtonText: { color: '#07110d', fontSize: 16, fontWeight: '700' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  header: {
    height: 56,
    marginHorizontal: 20,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(126, 249, 198, 0.5)',
    backgroundColor: 'rgba(5, 8, 7, 0.68)',
  },
  brand: { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#f0c85a' },
  lockedDot: { backgroundColor: '#7ef9c6' },
  flipButton: {
    minWidth: 62,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(126, 249, 198, 0.7)',
    borderRadius: 6,
    backgroundColor: 'rgba(5, 8, 7, 0.76)',
  },
  flipButtonPressed: { backgroundColor: 'rgba(126, 249, 198, 0.24)' },
  flipButtonText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  faceBox: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(240, 200, 90, 0.62)',
    backgroundColor: 'transparent',
  },
  faceBoxLocked: { borderColor: 'rgba(126, 249, 198, 0.72)', borderWidth: 1 },
  corner: { position: 'absolute', width: 24, height: 24, borderColor: '#f0c85a' },
  cornerTopLeft: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4 },
  cornerTopRight: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4 },
  cornerBottomLeft: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4 },
  cornerBottomRight: { right: -2, bottom: -2, borderRightWidth: 4, borderBottomWidth: 4 },
  scanLine: {
    position: 'absolute',
    top: 0,
    left: 5,
    right: 5,
    height: 2,
    backgroundColor: '#7ef9c6',
    shadowColor: '#7ef9c6',
    shadowOpacity: 0.9,
    shadowRadius: 5,
  },
  lockBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
    backgroundColor: '#7ef9c6',
  },
  lockBadgeText: { color: '#07110d', fontSize: 10, fontWeight: '900' },
  statusPanel: {
    margin: 20,
    marginBottom: 28,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderLeftWidth: 3,
    borderLeftColor: '#7ef9c6',
    backgroundColor: 'rgba(5, 8, 7, 0.82)',
  },
  statusHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  statusLabel: { color: '#94a59e', fontSize: 11, fontWeight: '700' },
  status: { marginTop: 5, color: '#ffffff', fontSize: 24, fontWeight: '700' },
  statusLocked: { color: '#7ef9c6' },
  readyState: { color: '#f0c85a', fontSize: 11, fontWeight: '800' },
  readyStateLocked: { color: '#7ef9c6' },
  threatPanel: { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(148, 165, 158, 0.3)', paddingTop: 12 },
  threatHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  threatLabel: { color: '#94a59e', fontSize: 10, fontWeight: '700' },
  threatValue: { color: '#d8e2de', fontSize: 10, fontWeight: '700' },
  threatTrack: { height: 5, marginTop: 8, overflow: 'hidden', backgroundColor: 'rgba(148, 165, 158, 0.24)' },
  threatFill: { height: '100%', backgroundColor: '#f0c85a' },
  threatFillLocked: { backgroundColor: '#7ef9c6' },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  metric: { color: '#94a59e', fontSize: 9, fontWeight: '700' },
});
