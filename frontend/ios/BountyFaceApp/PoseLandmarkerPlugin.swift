import ImageIO
import MediaPipeTasksVision
import Vision
import VisionCamera

@objc(PoseLandmarkerPlugin)
public class PoseLandmarkerPlugin: FrameProcessorPlugin {
  private var poseLandmarker: PoseLandmarker?
  private let faceRequest = VNDetectFaceRectanglesRequest()

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
    setupLandmarker()
  }

  private func setupLandmarker() {
    guard let modelPath = Bundle.main.path(
      forResource: "pose_landmarker_full",
      ofType: "task"
    ) else {
      print("[PoseLandmarker] Model file not found in bundle")
      return
    }

    let options = PoseLandmarkerOptions()
    options.baseOptions.modelAssetPath = modelPath
    options.baseOptions.delegate = .GPU
    options.runningMode = .video
    options.numPoses = 1
    options.minPoseDetectionConfidence = 0.3
    options.minPosePresenceConfidence = 0.3
    options.minTrackingConfidence = 0.3

    do {
      poseLandmarker = try PoseLandmarker(options: options)
      print("[PoseLandmarker] Initialized")
    } catch {
      print("[PoseLandmarker] Initialization failed: \(error)")
    }
  }

  public override func callback(
    _ frame: Frame,
    withArguments arguments: [AnyHashable: Any]?
  ) -> Any? {
    let cameraFacing = arguments?["cameraFacing"] as? String
    let orientation: CGImagePropertyOrientation = cameraFacing == "front" ? .leftMirrored : .right
    let faceHandler = VNImageRequestHandler(
      cmSampleBuffer: frame.buffer,
      orientation: orientation,
      options: [:]
    )
    try? faceHandler.perform([faceRequest])

    let faces = (faceRequest.results ?? []).map { face -> [String: Any] in
      let bounds = face.boundingBox
      var value: [String: Any] = [
        "x": bounds.origin.x,
        "y": bounds.origin.y,
        "width": bounds.width,
        "height": bounds.height,
      ]
      if let yaw = face.yaw {
        value["yawAngle"] = yaw.doubleValue * 180 / Double.pi
      }
      if let roll = face.roll {
        value["rollAngle"] = roll.doubleValue * 180 / Double.pi
      }
      return value
    }

    var outputLandmarks: [[String: Any]] = []
    if let poseLandmarker,
       let image = try? MPImage(sampleBuffer: frame.buffer),
       let result = try? poseLandmarker.detect(
         videoFrame: image,
         timestampInMilliseconds: Int(frame.timestamp)
       ),
       let landmarks = result.landmarks.first {
      outputLandmarks = landmarks.map { landmark -> [String: Any] in
      var value: [String: Any] = [
        "x": landmark.x,
        "y": landmark.y,
        "z": landmark.z,
      ]
      if let visibility = landmark.visibility {
        value["visibility"] = visibility.floatValue
      }
      return value
      }
    }

    return ["faces": faces, "landmarks": outputLandmarks]
  }
}
