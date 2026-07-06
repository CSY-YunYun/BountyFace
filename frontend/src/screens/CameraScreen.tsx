import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import {
  analyzeTargetScan,
  ApiScanResult,
  ApiTargetProfile,
  confirmTargetMatch,
  generateTarget,
  getTarget,
  scanFace,
  updateTargetDisplayName,
} from '../services/api';

type ScanMode = 'selfie' | 'field';
type ProfileSource = 'ai' | 'mock' | 'matched';

type ScanStatus =
  | 'idle'
  | 'searchingFace'
  | 'faceDetected'
  | 'faceLocked'
  | 'tracking'
  | 'lostTracking'
  | 'analyzing'
  | 'possibleMatch'
  | 'completed';

type PossibleMatchCandidate = {
  targetId: string;
  temporaryScanId: string;
  profile: ApiTargetProfile;
  confidence: number;
  photoPath: string;
};

type MockProfile = {
  id: string;
  displayName: string;
  codename: string;
  basePower: number;
  threatLevel: string;
  level: number;
  str: number;
  dex: number;
  int: number;
  luk: number;
  description: string;
  isPublicFigure: boolean;
  isVerified: boolean;
  isNameEditable: boolean;
};

type FaceBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PoseLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
};

type ScreenPoint = {
  x: number;
  y: number;
  visible: boolean;
};

type NativeFace = {
  x: number;
  y: number;
  width: number;
  height: number;
  yawAngle?: number;
  rollAngle?: number;
};

type DetectedFace = {
  bounds: FaceBounds;
  yawAngle?: number;
  rollAngle?: number;
};

type NativeScanResult = {
  faces?: NativeFace[];
  landmarks?: PoseLandmark[];
  embedding?: number[];
  faceQuality?: {
    brightness: number;
    sharpness: number;
  };
};

type PoseQuality = {
  hasHead: boolean;
  hasShoulders: boolean;
  hasUpperBody: boolean;
  hasArms: boolean;
  hasFullBody: boolean;
  isFacingCamera: boolean;
  confidence: number;
};

const posePlugin = VisionCameraProxy.initFrameProcessorPlugin('poseLandmarker', {});

const REQUIRED_STABLE_MS = 1000;
const FACE_DETECTION_GRACE_MS = 400;
const MAX_YAW_ANGLE = 30;
const MAX_ROLL_ANGLE = 22;
const MIN_SELFIE_FACE_WIDTH_RATIO = 0.3;
const MIN_FIELD_FACE_WIDTH_RATIO = 0.1;
const MAX_CENTER_OFFSET_X_RATIO = 0.24;
const MAX_CENTER_OFFSET_Y_RATIO = 0.28;
const MIN_LANDMARK_VISIBILITY = 0.45;
const MIN_FACE_BRIGHTNESS = 0.15;
const MAX_FACE_BRIGHTNESS = 0.92;
const MIN_FACE_SHARPNESS = 0.018;
const POSE_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];
const DISPLAYED_LANDMARKS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const STATUS_PROGRESS: Record<ScanStatus, number> = {
  idle: 0,
  searchingFace: 0,
  faceDetected: 0.25,
  faceLocked: 0.5,
  tracking: 0.8,
  lostTracking: 0.8,
  analyzing: 0.9,
  possibleMatch: 0.9,
  completed: 1,
};
const STATUS_COPY: Record<ScanStatus, string> = {
  idle: 'Scanner ready',
  searchingFace: 'Searching for face...',
  faceDetected: 'Checking face quality...',
  faceLocked: 'Face locked',
  tracking: 'Target tracking',
  lostTracking: 'Signal lost...',
  analyzing: 'Analyzing target...',
  possibleMatch: 'Possible identity match',
  completed: 'Scan completed',
};

const LOST_TRACKING_TIMEOUT_MS = 1000;
const EMPTY_POSE_QUALITY: PoseQuality = {
  hasHead: false,
  hasShoulders: false,
  hasUpperBody: false,
  hasArms: false,
  hasFullBody: false,
  isFacingCamera: false,
  confidence: 0,
};

function evaluatePose(landmarks: PoseLandmark[] | null): PoseQuality {
  if (!landmarks || landmarks.length < 33) {
    return EMPTY_POSE_QUALITY;
  }

  const isVisible = (index: number) => (landmarks[index]?.visibility ?? 0) >= MIN_LANDMARK_VISIBILITY;
  const allVisible = (indices: number[]) => indices.every(isVisible);
  const confidenceIndices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const confidence = confidenceIndices.reduce(
    (sum, index) => sum + (landmarks[index]?.visibility ?? 0),
    0,
  ) / confidenceIndices.length;
  const hasHead = isVisible(0);
  const hasShoulders = allVisible([11, 12]);
  const hasUpperBody = hasShoulders && allVisible([23, 24]);
  const hasArms = allVisible([13, 14, 15, 16]);
  const hasFullBody = hasUpperBody && allVisible([25, 26, 27, 28]);
  const shoulderDepthDifference = Math.abs((landmarks[11]?.z ?? 1) - (landmarks[12]?.z ?? -1));

  return {
    hasHead,
    hasShoulders,
    hasUpperBody,
    hasArms,
    hasFullBody,
    isFacingCamera: hasShoulders && shoulderDepthDifference <= 0.16,
    confidence,
  };
}

function toUiProfile(profile: ApiTargetProfile): MockProfile {
  return {
    id: profile.id,
    displayName: profile.display_name,
    codename: profile.codename,
    basePower: profile.base_power,
    threatLevel: profile.threat_level,
    level: profile.level,
    str: profile.str,
    dex: profile.dex,
    int: profile.int,
    luk: profile.luk,
    description: profile.description,
    isPublicFigure: profile.is_public_figure,
    isVerified: profile.is_verified,
    isNameEditable: profile.is_name_editable,
  };
}

export function CameraScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [scanMode, setScanMode] = useState<ScanMode>('field');
  const cameraFacing = scanMode === 'selfie' ? 'front' : 'back';
  const device = useCameraDevice(cameraFacing);
  const camera = useRef<Camera>(null);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('searchingFace');
  const [qualityMessage, setQualityMessage] = useState('Find a clear face');
  const [faceBounds, setFaceBounds] = useState<FaceBounds | null>(null);
  const [poseLandmarks, setPoseLandmarks] = useState<PoseLandmark[]>([]);
  const [poseQuality, setPoseQuality] = useState<PoseQuality>(EMPTY_POSE_QUALITY);
  const [faceEmbedding, setFaceEmbedding] = useState<number[] | null>(null);
  const [mockProfile, setMockProfile] = useState<MockProfile | null>(null);
  const [profileSource, setProfileSource] = useState<ProfileSource | null>(null);
  const [scanResult, setScanResult] = useState<ApiScanResult | null>(null);
  const [scanSource, setScanSource] = useState<'ai' | 'mock' | null>(null);
  const [possibleMatch, setPossibleMatch] = useState<PossibleMatchCandidate | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  const stableSince = useRef<number | null>(null);
  const lastValidFaceAt = useRef<number | null>(null);
  const analysisAttempted = useRef(false);
  const scanProgress = useRef(new Animated.Value(0)).current;
  const lockPulse = useRef(new Animated.Value(0)).current;
  const threatProgress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Camera.getCameraPermissionStatus();
    setPermissionChecked(true);
  }, []);

  useEffect(() => {
    stableSince.current = null;
    lastValidFaceAt.current = null;
    setScanStatus('searchingFace');
    setQualityMessage('Find a clear face');
    setFaceBounds(null);
    setPoseLandmarks([]);
    setPoseQuality(EMPTY_POSE_QUALITY);
    setFaceEmbedding(null);
    setMockProfile(null);
    setProfileSource(null);
    setScanResult(null);
    setScanSource(null);
    setPossibleMatch(null);
    setIsEditingName(false);
    setDisplayNameDraft('');
    setIsSavingName(false);
    analysisAttempted.current = false;
    threatProgress.stopAnimation();
    threatProgress.setValue(0);
  }, [scanMode]);

  const hasFace = faceBounds !== null;
  const isLocked = !['idle', 'searchingFace', 'faceDetected'].includes(scanStatus);
  const isComplete = scanStatus === 'completed' || (scanStatus === 'tracking' && mockProfile !== null);
  const guidanceMessage = useMemo(() => {
    if (scanStatus === 'idle' || scanStatus === 'searchingFace' || scanStatus === 'faceDetected') {
      return qualityMessage;
    }
    if (scanStatus === 'faceLocked') {
      return 'Face identity anchor secured';
    }
    if (scanStatus === 'tracking') {
      return mockProfile ? 'Base profile active · current loadout analyzed' : 'Body scan optional';
    }
    if (scanStatus === 'lostTracking') {
      return 'Trying to reacquire target';
    }
    if (scanStatus === 'completed') {
      if (profileSource === 'ai') return 'AI profile generated';
      if (profileSource === 'matched') return 'Existing profile matched';
      return 'Mock profile ready';
    }
    if (scanStatus === 'possibleMatch') {
      return `Possible match · ${Math.round((possibleMatch?.confidence ?? 0) * 100)}%`;
    }
    if (scanStatus === 'analyzing' && !faceEmbedding) {
      return 'Generating face embedding...';
    }
    return 'Mock processing...';
  }, [faceEmbedding, mockProfile, possibleMatch, profileSource, qualityMessage, scanStatus]);
  const posePoints = useMemo<ScreenPoint[]>(() => poseLandmarks.map((landmark) => ({
    x: (cameraFacing === 'front' ? landmark.y : 1 - landmark.y) * screenWidth,
    y: landmark.x * screenHeight,
    visible: (landmark.visibility ?? 0) >= MIN_LANDMARK_VISIBILITY,
  })), [cameraFacing, poseLandmarks, screenHeight, screenWidth]);
  const poseDataLabel = poseQuality.hasFullBody
    ? 'FULL BODY'
    : poseQuality.hasUpperBody
      ? 'UPPER BODY'
      : poseQuality.hasShoulders
        ? 'PARTIAL'
        : hasFace
          ? 'FACE ONLY'
          : 'SEARCHING';
  const acquisitionProgress = mockProfile && ['tracking', 'lostTracking'].includes(scanStatus)
    ? STATUS_PROGRESS.completed
    : STATUS_PROGRESS[scanStatus];

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
    if (scanStatus !== 'faceDetected') {
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
  }, [isLocked, lockPulse, scanStatus]);

  useEffect(() => {
    Animated.timing(threatProgress, {
      toValue: acquisitionProgress,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [acquisitionProgress, threatProgress]);

  useEffect(() => {
    let nextStatus: ScanStatus | null = null;
    let delay = 700;

    if (scanStatus === 'faceLocked') {
      nextStatus = 'tracking';
      delay = 300;
    } else if (scanStatus === 'tracking' && !mockProfile && !analysisAttempted.current) {
      nextStatus = 'analyzing';
      delay = scanMode === 'field' ? 900 : 350;
    } else if (scanStatus === 'completed') {
      nextStatus = 'tracking';
      delay = 650;
    }

    if (!nextStatus) {
      return;
    }

    const timeout = setTimeout(() => {
      setScanStatus(nextStatus);
    }, delay);
    return () => clearTimeout(timeout);
  }, [mockProfile, scanMode, scanStatus]);

  const completeScan = useCallback((
    apiProfile: ApiTargetProfile,
    apiScanResult: ApiScanResult,
    source: ProfileSource,
    apiScanSource: 'ai' | 'mock',
  ) => {
    const profile = toUiProfile(apiProfile);
    setMockProfile(profile);
    setProfileSource(source);
    setScanResult(apiScanResult);
    setScanSource(apiScanSource);
    if (
      scanMode === 'selfie'
      && apiProfile.is_name_editable
      && !apiProfile.is_public_figure
      && apiProfile.display_name === '匿名'
    ) {
      setDisplayNameDraft('');
      setIsEditingName(true);
    }
    setPossibleMatch(null);
    setScanStatus('completed');
  }, [scanMode]);

  useEffect(() => {
    if (scanStatus !== 'analyzing' || !faceEmbedding || analysisAttempted.current) {
      return;
    }

    analysisAttempted.current = true;
    const controller = new AbortController();

    const analyzeTarget = async () => {
      try {
        const scan = await scanFace(faceEmbedding, controller.signal);
        const photo = await camera.current?.takePhoto({ enableShutterSound: false });
        if (!photo?.path) {
          throw new Error('Scan image unavailable.');
        }
        let apiProfile: ApiTargetProfile;
        let apiScanResult: ApiScanResult;
        let apiScanSource: 'ai' | 'mock';
        let source: ProfileSource;
        if (
          scan.matchStatus === 'possible'
          && scan.targetId
          && scan.temporaryScanId
        ) {
          const target = await getTarget(scan.targetId, controller.signal);
          setPossibleMatch({
            targetId: scan.targetId,
            temporaryScanId: scan.temporaryScanId,
            profile: target.profile,
            confidence: scan.confidence ?? 0,
            photoPath: photo.path,
          });
          setQualityMessage('Confirm identity or create a new version');
          setScanStatus('possibleMatch');
          return;
        }

        if (scan.matchStatus === 'confirmed' && scan.targetId) {
          const analyzed = await analyzeTargetScan(scan.targetId, photo.path, controller.signal);
          apiProfile = analyzed.profile;
          apiScanResult = analyzed.scan_result;
          apiScanSource = analyzed.generationSource;
          source = 'matched';
          setQualityMessage('Existing profile · current scan updated');
        } else if (scan.matchStatus === 'new' && scan.temporaryScanId) {
          const generated = await generateTarget(
            scan.temporaryScanId,
            faceEmbedding,
            scanMode,
            photo.path,
            controller.signal,
          );
          apiProfile = generated.profile;
          apiScanResult = generated.scan_result;
          apiScanSource = generated.generationSource;
          source = generated.generationSource;
          setQualityMessage(
            generated.generationSource === 'ai'
              ? 'AI profile generated'
              : 'Mock profile generated',
          );
        } else {
          throw new Error('Invalid scan response.');
        }

        completeScan(apiProfile, apiScanResult, source, apiScanSource);
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }
        setQualityMessage(
          (error as Error).message.toLowerCase().includes('scan image')
            ? 'Scan image unavailable'
            : 'Backend unavailable',
        );
        setScanStatus('tracking');
      }
    };

    analyzeTarget();
    return () => controller.abort();
  }, [completeScan, faceEmbedding, scanMode, scanStatus]);

  const handleConfirmPossibleMatch = useCallback(async () => {
    if (!possibleMatch) return;
    setScanStatus('analyzing');
    try {
      await confirmTargetMatch(possibleMatch.targetId, possibleMatch.temporaryScanId);
      const analyzed = await analyzeTargetScan(possibleMatch.targetId, possibleMatch.photoPath);
      setQualityMessage('Face variant confirmed · current scan updated');
      completeScan(analyzed.profile, analyzed.scan_result, 'matched', analyzed.generationSource);
    } catch {
      setQualityMessage('Unable to confirm match');
      setScanStatus('possibleMatch');
    }
  }, [completeScan, possibleMatch]);

  const handleCreatePossibleMatch = useCallback(async () => {
    if (!possibleMatch || !faceEmbedding) return;
    setScanStatus('analyzing');
    try {
      const generated = await generateTarget(
        possibleMatch.temporaryScanId,
        faceEmbedding,
        scanMode,
        possibleMatch.photoPath,
      );
      setQualityMessage('New character version created');
      completeScan(
        generated.profile,
        generated.scan_result,
        generated.generationSource,
        generated.generationSource,
      );
    } catch {
      setQualityMessage('Unable to create target');
      setScanStatus('possibleMatch');
    }
  }, [completeScan, faceEmbedding, possibleMatch, scanMode]);

  const handleRescanLoadout = useCallback(() => {
    stableSince.current = null;
    lastValidFaceAt.current = null;
    analysisAttempted.current = false;
    setFaceEmbedding(null);
    setMockProfile(null);
    setProfileSource(null);
    setScanResult(null);
    setScanSource(null);
    setPossibleMatch(null);
    setQualityMessage('Hold still for a new loadout scan');
    setScanStatus('searchingFace');
  }, []);

  const handleEditDisplayName = useCallback(() => {
    if (!mockProfile) return;
    setDisplayNameDraft(mockProfile.displayName === '匿名' ? '' : mockProfile.displayName);
    setIsEditingName(true);
  }, [mockProfile]);

  const handleSaveDisplayName = useCallback(async () => {
    if (!mockProfile || scanMode !== 'selfie') return;
    const displayName = displayNameDraft.trim();
    if (!displayName) {
      setQualityMessage('Display name cannot be empty');
      return;
    }

    setIsSavingName(true);
    try {
      const updated = await updateTargetDisplayName(mockProfile.id, displayName, scanMode);
      setMockProfile((current) => current
        ? { ...current, displayName: updated.profile.display_name }
        : current);
      setIsEditingName(false);
      setQualityMessage('Display name updated');
    } catch {
      setQualityMessage('Unable to update display name');
    } finally {
      setIsSavingName(false);
    }
  }, [displayNameDraft, mockProfile, scanMode]);

  useEffect(() => {
    if (scanStatus !== 'lostTracking') {
      return;
    }

    const timeout = setTimeout(() => {
      stableSince.current = null;
      lastValidFaceAt.current = null;
      setFaceBounds(null);
      setPoseLandmarks([]);
      setPoseQuality(EMPTY_POSE_QUALITY);
      setFaceEmbedding(null);
      setMockProfile(null);
      setProfileSource(null);
      setScanResult(null);
      setScanSource(null);
      analysisAttempted.current = false;
      setQualityMessage('Find a clear face');
      setScanStatus('searchingFace');
    }, LOST_TRACKING_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [scanStatus]);

  const handleFacesDetected = useCallback((faces: DetectedFace[]) => {
    const face = faces[0];

    if (scanStatus === 'possibleMatch') {
      return;
    }

    if (scanStatus === 'lostTracking') {
      if (face) {
        setFaceBounds(face.bounds);
        setQualityMessage('Target reacquired');
        setScanStatus('tracking');
      }
      return;
    }

    const trackingStatuses: ScanStatus[] = ['faceLocked', 'tracking', 'analyzing', 'completed'];
    if (trackingStatuses.includes(scanStatus)) {
      if (face) {
        setFaceBounds(face.bounds);
        return;
      }

      if (!mockProfile) {
        analysisAttempted.current = false;
      }
      setQualityMessage('Signal lost');
      setScanStatus('lostTracking');
      return;
    }

    if (!face) {
      const now = Date.now();
      if (
        scanStatus === 'faceDetected'
        && lastValidFaceAt.current !== null
        && now - lastValidFaceAt.current <= FACE_DETECTION_GRACE_MS
      ) {
        return;
      }
      stableSince.current = null;
      lastValidFaceAt.current = null;
      setFaceBounds(null);
      setScanStatus('searchingFace');
      setQualityMessage('Find a clear face');
      return;
    }

    const bounds = face.bounds as FaceBounds;
    setFaceBounds(bounds);
    setScanStatus('faceDetected');

    const minimumFaceWidth = scanMode === 'selfie'
      ? MIN_SELFIE_FACE_WIDTH_RATIO
      : MIN_FIELD_FACE_WIDTH_RATIO;
    const faceIsLargeEnough = bounds.width / screenWidth >= minimumFaceWidth;
    if (!faceIsLargeEnough) {
      stableSince.current = null;
      lastValidFaceAt.current = null;
      setQualityMessage('Move closer');
      return;
    }

    const faceCenterX = bounds.x + bounds.width / 2;
    const faceCenterY = bounds.y + bounds.height / 2;
    const centerOffsetX = Math.abs(faceCenterX - screenWidth / 2) / screenWidth;
    const centerOffsetY = Math.abs(faceCenterY - screenHeight / 2) / screenHeight;
    const yaw = Math.abs(face.yawAngle ?? 0);
    const roll = Math.abs(face.rollAngle ?? 0);
    const faceIsCentered = centerOffsetX <= MAX_CENTER_OFFSET_X_RATIO
      && centerOffsetY <= MAX_CENTER_OFFSET_Y_RATIO;
    const faceIsForward = yaw <= MAX_YAW_ANGLE && roll <= MAX_ROLL_ANGLE;
    const withinQualityGrace = lastValidFaceAt.current !== null
      && Date.now() - lastValidFaceAt.current <= FACE_DETECTION_GRACE_MS;

    if (!faceIsCentered) {
      if (withinQualityGrace) return;
      stableSince.current = null;
      lastValidFaceAt.current = null;
      setQualityMessage('Move face toward center');
      return;
    }

    if (!faceIsForward) {
      if (withinQualityGrace) return;
      stableSince.current = null;
      lastValidFaceAt.current = null;
      setQualityMessage('Turn slightly toward camera');
      return;
    }

    setQualityMessage('Hold still');
    const now = Date.now();
    lastValidFaceAt.current = now;
    stableSince.current ??= now;
    if (now - stableSince.current >= REQUIRED_STABLE_MS) {
      setQualityMessage('Identity ready');
      setScanStatus('faceLocked');
      return;
    }
  }, [mockProfile, scanMode, scanStatus, screenHeight, screenWidth]);

  const handleScanResult = useCallback((result: NativeScanResult | null) => {
    const faces = (result?.faces ?? []).map((face): DetectedFace => ({
      bounds: {
        x: face.x * screenWidth,
        y: (1 - face.y - face.height) * screenHeight,
        width: face.width * screenWidth,
        height: face.height * screenHeight,
      },
      yawAngle: face.yawAngle,
      rollAngle: face.rollAngle,
    }));
    handleFacesDetected(faces);
    const landmarks = result?.landmarks ?? [];
    const shouldCheckPose = scanMode === 'field'
      && ['tracking', 'analyzing', 'completed'].includes(scanStatus);
    if (shouldCheckPose) {
      setPoseLandmarks(landmarks);
      setPoseQuality(evaluatePose(landmarks));
    }
    if (!faceEmbedding && result?.embedding?.length) {
      const quality = result.faceQuality;
      if (quality && quality.brightness < MIN_FACE_BRIGHTNESS) {
        setQualityMessage('Improve lighting');
        return;
      }
      if (quality && quality.brightness > MAX_FACE_BRIGHTNESS) {
        setQualityMessage('Reduce lighting');
        return;
      }
      if (quality && quality.sharpness < MIN_FACE_SHARPNESS) {
        setQualityMessage('Hold still · image blurred');
        return;
      }
      setFaceEmbedding(result.embedding);
    }
  }, [faceEmbedding, handleFacesDetected, scanMode, scanStatus, screenHeight, screenWidth]);
  const reportScanToJS = useMemo(
    () => Worklets.createRunOnJS(handleScanResult),
    [handleScanResult],
  );
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    runAtTargetFps(8, () => {
      'worklet';
      if (!posePlugin) {
        reportScanToJS(null);
        return;
      }
      const result = posePlugin.call(frame, {
        cameraFacing,
        generateEmbedding: scanStatus === 'analyzing' && faceEmbedding === null,
      }) as unknown as NativeScanResult | null;
      reportScanToJS(result);
    });
  }, [cameraFacing, faceEmbedding, reportScanToJS, scanStatus]);

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
        pixelFormat="rgb"
        photo
      />

      <SafeAreaView pointerEvents="box-none" style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.brand}>BOUNTYFACE</Text>
          <View style={styles.headerActions}>
            <View style={styles.modeControl}>
              {(['selfie', 'field'] as ScanMode[]).map((mode) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: scanMode === mode }}
                  key={mode}
                  onPress={() => setScanMode(mode)}
                  style={[styles.modeButton, scanMode === mode && styles.modeButtonActive]}
                >
                  <Text style={[styles.modeButtonText, scanMode === mode && styles.modeButtonTextActive]}>
                    {mode.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={[styles.liveDot, isLocked && styles.lockedDot]} />
          </View>
        </View>

        {faceBounds && (
          <Animated.View
            style={[
              styles.faceBox,
              isLocked && styles.faceBoxLocked,
              scanStatus === 'lostTracking' && styles.faceBoxLost,
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
              <View style={[
                styles.lockBadge,
                scanStatus === 'lostTracking' && styles.lockBadgeLost,
              ]}>
                <Text style={styles.lockBadgeText}>
                  {scanStatus === 'lostTracking' ? 'LOST' : 'LOCK'}
                </Text>
              </View>
            )}
          </Animated.View>
        )}

        {scanMode === 'field' && posePoints.length >= 33 && (
          <View pointerEvents="none" style={styles.poseOverlay}>
            {POSE_CONNECTIONS.map(([startIndex, endIndex]) => {
              const start = posePoints[startIndex];
              const end = posePoints[endIndex];
              if (!start?.visible || !end?.visible) {
                return null;
              }

              const distance = Math.hypot(end.x - start.x, end.y - start.y);
              const angle = Math.atan2(end.y - start.y, end.x - start.x);
              return (
                <View
                  key={`${startIndex}-${endIndex}`}
                  style={[
                    styles.poseBone,
                    {
                      left: (start.x + end.x - distance) / 2,
                      top: (start.y + end.y) / 2 - 1,
                      width: distance,
                      transform: [{ rotate: `${angle}rad` }],
                    },
                  ]}
                />
              );
            })}
            {DISPLAYED_LANDMARKS.map((index) => {
              const point = posePoints[index];
              if (!point?.visible) {
                return null;
              }

              return (
                <View
                  key={index}
                  style={[styles.poseJoint, { left: point.x - 4, top: point.y - 4 }]}
                />
              );
            })}
          </View>
        )}

        <View style={styles.statusPanel}>
          <View style={styles.statusHeading}>
            <View>
              <Text style={styles.statusLabel}>{scanMode.toUpperCase()} MODE</Text>
              <Text style={[
                styles.status,
                isLocked && styles.statusLocked,
                scanStatus === 'lostTracking' && styles.statusLost,
              ]}>
                {mockProfile && scanStatus === 'tracking'
                  ? 'Target identified'
                  : STATUS_COPY[scanStatus]}
              </Text>
              <Text style={styles.qualityMessage}>{guidanceMessage}</Text>
            </View>
            <Text style={[
              styles.readyState,
              isComplete && styles.readyStateLocked,
              scanStatus === 'lostTracking' && styles.readyStateLost,
            ]}>
              {scanStatus === 'lostTracking' ? 'LOST' : isComplete ? 'IDENTIFIED' : 'SCANNING'}
            </Text>
          </View>

          <View style={styles.threatPanel}>
            <View style={styles.threatHeader}>
              <Text style={styles.threatLabel}>SCAN PROGRESS</Text>
              <Text style={styles.threatValue}>{Math.round(acquisitionProgress * 100)}%</Text>
            </View>
            <View style={styles.threatTrack}>
              <Animated.View
                style={[
                  styles.threatFill,
                  (isLocked || poseQuality.hasFullBody) && styles.threatFillLocked,
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
              <Text style={styles.metric}>MODE {scanMode.toUpperCase()}</Text>
              <Text style={styles.metric}>LOCK {isLocked ? 'YES' : 'NO'}</Text>
            </View>
            {possibleMatch && (
              <View style={styles.possibleMatchPanel}>
                <Text style={styles.possibleMatchLabel}>POSSIBLE MATCH</Text>
                <Text style={styles.possibleMatchFieldLabel}>IDENTITY / 身分</Text>
                <Text style={styles.possibleMatchName}>{possibleMatch.profile.display_name}?</Text>
                <Text style={styles.possibleMatchFieldLabel}>CODENAME / 稱號</Text>
                <Text style={styles.possibleMatchCodename}>{possibleMatch.profile.codename}</Text>
                <Text style={styles.possibleMatchConfidence}>
                  SIMILARITY {Math.round(possibleMatch.confidence * 100)}%
                </Text>
                <View style={styles.possibleMatchActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleConfirmPossibleMatch}
                    style={[styles.matchAction, styles.matchActionConfirm]}
                  >
                    <Text style={styles.matchActionConfirmText}>CONFIRM</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleCreatePossibleMatch}
                    style={[styles.matchAction, styles.matchActionNew]}
                  >
                    <Text style={styles.matchActionNewText}>CREATE NEW</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {scanMode === 'field' && !mockProfile && (
              <>
                <View style={styles.subjectRow}>
                  <View>
                    <Text style={styles.subjectLabel}>POSE DATA · OPTIONAL</Text>
                    <Text style={styles.subjectValue}>{poseDataLabel}</Text>
                  </View>
                  <Text style={styles.poseConfidence}>
                    POSE {Math.round(poseQuality.confidence * 100)}%
                  </Text>
                </View>
                <View style={styles.poseFlags}>
                  <Text style={[styles.poseFlag, poseQuality.hasHead && styles.poseFlagActive]}>HEAD</Text>
                  <Text style={[styles.poseFlag, poseQuality.hasShoulders && styles.poseFlagActive]}>SHOULDERS</Text>
                  <Text style={[styles.poseFlag, poseQuality.hasUpperBody && styles.poseFlagActive]}>TORSO</Text>
                  <Text style={[styles.poseFlag, poseQuality.hasArms && styles.poseFlagActive]}>ARMS</Text>
                  <Text style={[styles.poseFlag, poseQuality.isFacingCamera && styles.poseFlagActive]}>FRONT</Text>
                </View>
              </>
            )}
            {mockProfile && (
              <View style={styles.profilePanel}>
                <View style={styles.identityRow}>
                  <View>
                    <Text style={styles.identityLabel}>DISPLAY NAME / 顯示名稱</Text>
                    <Text style={styles.identityName}>{mockProfile.displayName}</Text>
                  </View>
                  {scanMode === 'selfie'
                    && mockProfile.isNameEditable
                    && !mockProfile.isPublicFigure
                    && !isEditingName && (
                      <Pressable
                        accessibilityRole="button"
                        onPress={handleEditDisplayName}
                        style={styles.editNameButton}
                      >
                        <Text style={styles.editNameButtonText}>EDIT</Text>
                      </Pressable>
                  )}
                </View>

                <View style={styles.profileHeader}>
                  <View>
                    <Text style={styles.profileLabel}>CURRENT CODENAME / 當前稱號</Text>
                    <Text style={styles.profileSource}>
                      {profileSource === 'ai'
                        ? 'AI GENERATED'
                        : profileSource === 'matched'
                          ? `MATCHED · ${scanSource === 'ai' ? 'AI SCAN' : 'MOCK SCAN'}`
                          : 'MOCK'}
                    </Text>
                    <Text style={styles.profileName}>
                      {scanResult?.scan_title ?? mockProfile.codename}
                    </Text>
                  </View>
                  <View style={styles.threatBadge}>
                    <Text style={styles.threatBadgeLabel}>THREAT</Text>
                    <Text style={styles.threatBadgeValue}>{mockProfile.threatLevel}</Text>
                  </View>
                </View>

                <View style={styles.powerRow}>
                  <View>
                    <Text style={styles.powerLabel}>BASE POWER / 基本戰力</Text>
                    <Text style={styles.powerValue}>
                      {mockProfile.basePower.toLocaleString('en-US')}
                    </Text>
                  </View>
                  <View style={styles.levelBlock}>
                    <Text style={styles.levelLabel}>LEVEL</Text>
                    <Text style={styles.levelValue}>LV. {mockProfile.level}</Text>
                  </View>
                </View>

                {scanResult && (
                  <View style={styles.scanResultBlock}>
                    <View style={styles.bonusRow}>
                      <Text style={styles.bonusLabel}>EQUIPMENT / 裝備加成</Text>
                      <Text style={styles.bonusValue}>+{scanResult.equipment_bonus}</Text>
                    </View>
                    <View style={styles.bonusRow}>
                      <Text style={styles.bonusLabel}>STYLE / 服裝加成</Text>
                      <Text style={styles.bonusValue}>+{scanResult.style_bonus}</Text>
                    </View>
                    <View style={styles.bonusRow}>
                      <Text style={styles.bonusLabel}>POSE / 姿勢加成</Text>
                      <Text style={styles.bonusValue}>+{scanResult.pose_bonus}</Text>
                    </View>
                    <View style={styles.currentPowerRow}>
                      <Text style={styles.currentPowerLabel}>CURRENT POWER / 目前戰力</Text>
                      <Text style={styles.currentPowerValue}>
                        {scanResult.current_power.toLocaleString('en-US')}
                      </Text>
                    </View>
                    <Text style={styles.scanStatus}>{scanResult.current_status}</Text>
                    {scanResult.detected_items.length > 0 && (
                      <Text style={styles.detectedItems}>
                        ITEMS · {scanResult.detected_items.join(' · ')}
                      </Text>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      onPress={handleRescanLoadout}
                      style={styles.rescanButton}
                    >
                      <Text style={styles.rescanButtonText}>RESCAN LOADOUT</Text>
                    </Pressable>
                  </View>
                )}

                <View style={styles.abilityGrid}>
                  {([
                    ['STR', '力量', mockProfile.str],
                    ['DEX', '敏捷', mockProfile.dex],
                    ['INT', '智力', mockProfile.int],
                    ['LUK', '幸運', mockProfile.luk],
                  ] as const).map(([code, label, value]) => (
                    <View key={code} style={styles.abilityItem}>
                      <Text style={styles.abilityCode}>{code}</Text>
                      <Text style={styles.abilityValue}>{value}</Text>
                      <Text style={styles.abilityLabel}>{label}</Text>
                    </View>
                  ))}
                </View>

                <View style={styles.descriptionBlock}>
                  <Text style={styles.descriptionLabel}>DESCRIPTION / 描述</Text>
                  <Text style={styles.descriptionText}>{mockProfile.description}</Text>
                </View>
              </View>
            )}
          </View>
        </View>
      </SafeAreaView>

      <Modal
        animationType="fade"
        onRequestClose={() => setIsEditingName(false)}
        transparent
        visible={isEditingName}
      >
        <View style={styles.nameModalBackdrop}>
          <View style={styles.nameModalPanel}>
            <Text style={styles.namePrompt}>要設定你的名稱嗎？</Text>
            <Text style={styles.nameModalCopy}>這只會修改你的 Display Name，AI 稱號仍會隨裝備改變。</Text>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              editable={!isSavingName}
              maxLength={40}
              onChangeText={setDisplayNameDraft}
              onSubmitEditing={handleSaveDisplayName}
              placeholder="輸入顯示名稱"
              placeholderTextColor="#66736e"
              returnKeyType="done"
              style={styles.nameInput}
              value={displayNameDraft}
            />
            <View style={styles.nameEditorActions}>
              <Pressable
                accessibilityRole="button"
                disabled={isSavingName}
                onPress={() => setIsEditingName(false)}
                style={styles.nameCancelButton}
              >
                <Text style={styles.nameCancelText}>CANCEL</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isSavingName}
                onPress={handleSaveDisplayName}
                style={styles.nameSaveButton}
              >
                <Text style={styles.nameSaveText}>{isSavingName ? 'SAVING' : 'SAVE'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#f0c85a' },
  lockedDot: { backgroundColor: '#7ef9c6' },
  modeControl: {
    height: 32,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'rgba(126, 249, 198, 0.54)',
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(5, 8, 7, 0.76)',
  },
  modeButton: {
    minWidth: 48,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: { backgroundColor: '#7ef9c6' },
  modeButtonText: { color: '#94a59e', fontSize: 9, fontWeight: '800' },
  modeButtonTextActive: { color: '#07110d' },
  faceBox: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(240, 200, 90, 0.62)',
    backgroundColor: 'transparent',
  },
  faceBoxLocked: { borderColor: 'rgba(126, 249, 198, 0.72)', borderWidth: 1 },
  faceBoxLost: { borderColor: 'rgba(240, 200, 90, 0.78)' },
  poseOverlay: { ...StyleSheet.absoluteFillObject },
  poseBone: {
    position: 'absolute',
    height: 2,
    backgroundColor: 'rgba(126, 249, 198, 0.78)',
    shadowColor: '#7ef9c6',
    shadowOpacity: 0.55,
    shadowRadius: 3,
  },
  poseJoint: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#07110d',
    backgroundColor: '#7ef9c6',
  },
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
  lockBadgeLost: { backgroundColor: '#f0c85a' },
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
  status: { marginTop: 5, color: '#ffffff', fontSize: 21, fontWeight: '700' },
  statusLocked: { color: '#7ef9c6' },
  statusLost: { color: '#f0c85a' },
  qualityMessage: { marginTop: 4, color: '#aebbb6', fontSize: 11, fontWeight: '600' },
  readyState: { color: '#f0c85a', fontSize: 11, fontWeight: '800' },
  readyStateLocked: { color: '#7ef9c6' },
  readyStateLost: { color: '#f0c85a' },
  threatPanel: { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(148, 165, 158, 0.3)', paddingTop: 12 },
  threatHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  threatLabel: { color: '#94a59e', fontSize: 10, fontWeight: '700' },
  threatValue: { color: '#d8e2de', fontSize: 10, fontWeight: '700' },
  threatTrack: { height: 5, marginTop: 8, overflow: 'hidden', backgroundColor: 'rgba(148, 165, 158, 0.24)' },
  threatFill: { height: '100%', backgroundColor: '#f0c85a' },
  threatFillLocked: { backgroundColor: '#7ef9c6' },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  metric: { color: '#94a59e', fontSize: 9, fontWeight: '700' },
  possibleMatchPanel: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#f0c85a',
    backgroundColor: 'rgba(240, 200, 90, 0.1)',
  },
  possibleMatchLabel: { color: '#f0c85a', fontSize: 9, fontWeight: '900' },
  possibleMatchFieldLabel: { marginTop: 8, color: '#94a59e', fontSize: 8, fontWeight: '800' },
  possibleMatchName: { marginTop: 2, color: '#ffffff', fontSize: 20, fontWeight: '900' },
  possibleMatchCodename: { marginTop: 2, color: '#7ef9c6', fontSize: 14, fontWeight: '800' },
  possibleMatchConfidence: { marginTop: 8, color: '#aebbb6', fontSize: 9, fontWeight: '700' },
  possibleMatchActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  matchAction: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center' },
  matchActionConfirm: { backgroundColor: '#7ef9c6' },
  matchActionNew: { borderWidth: 1, borderColor: '#f0c85a' },
  matchActionConfirmText: { color: '#07110d', fontSize: 10, fontWeight: '900' },
  matchActionNewText: { color: '#f0c85a', fontSize: 10, fontWeight: '900' },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 165, 158, 0.22)',
  },
  subjectLabel: { color: '#94a59e', fontSize: 9, fontWeight: '700' },
  subjectValue: { marginTop: 3, color: '#ffffff', fontSize: 15, fontWeight: '800' },
  poseConfidence: { color: '#7ef9c6', fontSize: 10, fontWeight: '800' },
  poseFlags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
  poseFlag: { color: '#66736e', fontSize: 8, fontWeight: '800' },
  poseFlagActive: { color: '#7ef9c6' },
  profilePanel: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(126, 249, 198, 0.45)',
  },
  identityRow: {
    marginBottom: 10,
    paddingBottom: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 165, 158, 0.25)',
  },
  identityLabel: { color: '#94a59e', fontSize: 8, fontWeight: '800' },
  identityName: { marginTop: 2, color: '#ffffff', fontSize: 18, fontWeight: '900' },
  editNameButton: {
    minWidth: 54,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#7ef9c6',
  },
  editNameButtonText: { color: '#7ef9c6', fontSize: 9, fontWeight: '900' },
  nameModalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  nameModalPanel: {
    width: '100%',
    maxWidth: 380,
    padding: 16,
    borderWidth: 1,
    borderColor: '#7ef9c6',
    backgroundColor: '#09110e',
  },
  namePrompt: { color: '#ffffff', fontSize: 18, fontWeight: '900' },
  nameModalCopy: { marginTop: 6, color: '#94a59e', fontSize: 11, lineHeight: 17 },
  nameInput: {
    height: 38,
    marginTop: 7,
    paddingHorizontal: 10,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: 'rgba(126, 249, 198, 0.5)',
    backgroundColor: 'rgba(5, 8, 7, 0.65)',
  },
  nameEditorActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  nameCancelButton: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center' },
  nameCancelText: { color: '#94a59e', fontSize: 9, fontWeight: '900' },
  nameSaveButton: {
    flex: 1,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7ef9c6',
  },
  nameSaveText: { color: '#07110d', fontSize: 9, fontWeight: '900' },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  profileLabel: { color: '#7ef9c6', fontSize: 9, fontWeight: '800' },
  profileSource: { marginTop: 3, color: '#f2c14e', fontSize: 10, fontWeight: '900' },
  profileName: { marginTop: 3, color: '#ffffff', fontSize: 24, fontWeight: '900' },
  threatBadge: {
    minWidth: 58,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#f0c85a',
    backgroundColor: 'rgba(240, 200, 90, 0.12)',
  },
  threatBadgeLabel: { color: '#f0c85a', fontSize: 8, fontWeight: '800' },
  threatBadgeValue: { marginTop: 1, color: '#ffffff', fontSize: 24, fontWeight: '900' },
  powerRow: {
    marginTop: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(148, 165, 158, 0.25)',
  },
  powerLabel: { color: '#94a59e', fontSize: 8, fontWeight: '800' },
  powerValue: {
    marginTop: 1,
    color: '#7ef9c6',
    fontSize: 40,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  levelBlock: { alignItems: 'flex-end', paddingBottom: 4 },
  levelLabel: { color: '#94a59e', fontSize: 8, fontWeight: '800' },
  levelValue: { marginTop: 3, color: '#ffffff', fontSize: 16, fontWeight: '900' },
  scanResultBlock: {
    marginTop: 9,
    padding: 9,
    borderWidth: 1,
    borderColor: 'rgba(240, 200, 90, 0.4)',
    backgroundColor: 'rgba(240, 200, 90, 0.07)',
  },
  bonusRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  bonusLabel: { color: '#aebbb6', fontSize: 8, fontWeight: '700' },
  bonusValue: { color: '#f0c85a', fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  currentPowerRow: {
    marginTop: 4,
    paddingTop: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: 'rgba(240, 200, 90, 0.3)',
  },
  currentPowerLabel: { color: '#f0c85a', fontSize: 8, fontWeight: '900' },
  currentPowerValue: { color: '#ffffff', fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] },
  scanStatus: { marginTop: 5, color: '#7ef9c6', fontSize: 10, fontWeight: '800' },
  detectedItems: { marginTop: 3, color: '#94a59e', fontSize: 8, fontWeight: '700' },
  rescanButton: {
    height: 34,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#7ef9c6',
  },
  rescanButtonText: { color: '#7ef9c6', fontSize: 9, fontWeight: '900' },
  abilityGrid: { flexDirection: 'row', gap: 5, marginTop: 10 },
  abilityItem: {
    flex: 1,
    minWidth: 0,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 2,
    borderLeftColor: '#7ef9c6',
    backgroundColor: 'rgba(126, 249, 198, 0.08)',
  },
  abilityCode: { color: '#94a59e', fontSize: 8, fontWeight: '800' },
  abilityValue: { marginTop: 1, color: '#ffffff', fontSize: 19, fontWeight: '900' },
  abilityLabel: { color: '#7ef9c6', fontSize: 8, fontWeight: '700' },
  descriptionBlock: { marginTop: 10 },
  descriptionLabel: { color: '#94a59e', fontSize: 8, fontWeight: '800' },
  descriptionText: {
    marginTop: 4,
    color: '#d8e2de',
    fontSize: 11,
    lineHeight: 17,
  },
});
