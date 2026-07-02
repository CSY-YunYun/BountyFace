import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraActive, setIsCameraActive] = useState(true);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<'back' | 'front'>('back');

  useEffect(() => {
    if (permission?.granted) {
      setReady(true);
    }
  }, [permission]);

  if (!permission) {
    return <View style={styles.center}><Text style={styles.text}>Loading camera…</Text></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>BountyFace</Text>
        <Text style={styles.text}>Camera access is needed for facial recognition.</Text>
        <Pressable style={styles.button} onPress={() => requestPermission().catch(() => undefined)}>
          <Text style={styles.buttonText}>Allow Camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView style={styles.camera} facing={facing} />

      <View style={styles.overlay}>
        <Text style={styles.title}>BountyFace</Text>
        <Text style={styles.subtitle}>{ready ? 'Face scan ready' : 'Preparing camera…'}</Text>

        <View style={styles.controlsRow}>
          <Pressable style={styles.button} onPress={() => setIsCameraActive((value) => !value)}>
            <Text style={styles.buttonText}>{isCameraActive ? 'Pause Scan' : 'Resume Scan'}</Text>
          </Pressable>

          <Pressable
            style={styles.secondaryButton}
            onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}
          >
            <Text style={styles.secondaryButtonText}>{facing === 'back' ? 'Use Selfie' : 'Use Back Camera'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 24,
    paddingTop: 56,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#050816',
    padding: 24,
  },
  title: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '700',
  },
  subtitle: {
    color: '#d9e6f4',
    fontSize: 16,
    marginTop: 8,
  },
  text: {
    color: '#d9e6f4',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 16,
  },
  controlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#26f7ff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.16)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#fff',
  },
  buttonText: {
    color: '#05101f',
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
});
