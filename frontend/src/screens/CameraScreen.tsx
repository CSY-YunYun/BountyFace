import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  const device = useCameraDevice('front');
  const camera = useRef<Camera>(null);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [status, setStatus] = useState<ScanStatus>('Searching target...');
  const [faceBounds, setFaceBounds] = useState<FaceBounds | null>(null);
  const stableSince = useRef<number | null>(null);
  const lastStatus = useRef<ScanStatus>('Searching target...');

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
  }), [screenHeight, screenWidth]);
  const { detectFaces, stopListeners } = useFaceDetector(detectionOptions);

  useEffect(() => stopListeners, [stopListeners]);

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
        <Text style={styles.message}>Front camera unavailable</Text>
      </View>
    );
  }

  const isLocked = status === 'Target locked';

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

      <SafeAreaView pointerEvents="none" style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.brand}>BOUNTYFACE</Text>
          <View style={[styles.liveDot, isLocked && styles.lockedDot]} />
        </View>

        {faceBounds && (
          <View
            style={[
              styles.faceBox,
              isLocked && styles.faceBoxLocked,
              {
                left: faceBounds.x,
                top: faceBounds.y,
                width: faceBounds.width,
                height: faceBounds.height,
              },
            ]}
          />
        )}

        <View style={styles.statusPanel}>
          <Text style={styles.statusLabel}>FACE ACQUISITION</Text>
          <Text style={[styles.status, isLocked && styles.statusLocked]}>{status}</Text>
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
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#f0c85a' },
  lockedDot: { backgroundColor: '#7ef9c6' },
  faceBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#f0c85a',
    backgroundColor: 'transparent',
  },
  faceBoxLocked: { borderColor: '#7ef9c6', borderWidth: 3 },
  statusPanel: {
    margin: 20,
    marginBottom: 28,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderLeftWidth: 3,
    borderLeftColor: '#7ef9c6',
    backgroundColor: 'rgba(5, 8, 7, 0.82)',
  },
  statusLabel: { color: '#94a59e', fontSize: 11, fontWeight: '700' },
  status: { marginTop: 5, color: '#ffffff', fontSize: 24, fontWeight: '700' },
  statusLocked: { color: '#7ef9c6' },
});
