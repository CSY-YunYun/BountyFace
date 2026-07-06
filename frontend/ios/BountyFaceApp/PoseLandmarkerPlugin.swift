import CoreImage
import ImageIO
import MediaPipeTasksVision
import TensorFlowLite
import Vision
import VisionCamera

private struct FaceEmbeddingOutput {
  let embedding: [Float]
  let brightness: Float
  let sharpness: Float
}

@objc(PoseLandmarkerPlugin)
public class PoseLandmarkerPlugin: FrameProcessorPlugin {
  private var poseLandmarker: PoseLandmarker?
  private var faceInterpreter: Interpreter?
  private let faceRequest = VNDetectFaceRectanglesRequest()
  private let imageContext = CIContext(options: [.cacheIntermediates: false])
  private let embeddingLock = NSLock()

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
    setupLandmarker()
    setupFaceInterpreter()
  }

  private func setupFaceInterpreter() {
    guard let modelPath = Bundle.main.path(forResource: "mobile_face_net", ofType: "tflite") else {
      print("[FaceEmbedding] Model file not found in bundle")
      return
    }

    do {
      var options = Interpreter.Options()
      options.threadCount = 2
      let interpreter = try Interpreter(modelPath: modelPath, options: options)
      try interpreter.allocateTensors()
      faceInterpreter = interpreter
      print("[FaceEmbedding] Initialized")
    } catch {
      print("[FaceEmbedding] Initialization failed: \(error)")
    }
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

    var embeddingOutput: FaceEmbeddingOutput?
    if arguments?["generateEmbedding"] as? Bool == true,
       let face = faceRequest.results?.first {
      embeddingOutput = generateEmbedding(
        from: frame.buffer,
        faceBounds: face.boundingBox,
        orientation: orientation
      )
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

    var output: [String: Any] = ["faces": faces, "landmarks": outputLandmarks]
    if let embeddingOutput {
      output["embedding"] = embeddingOutput.embedding
      output["faceQuality"] = [
        "brightness": embeddingOutput.brightness,
        "sharpness": embeddingOutput.sharpness,
      ]
    }
    return output
  }

  private func generateEmbedding(
    from sampleBuffer: CMSampleBuffer,
    faceBounds: CGRect,
    orientation: CGImagePropertyOrientation
  ) -> FaceEmbeddingOutput? {
    guard let interpreter = faceInterpreter,
          let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return nil
    }

    let source = CIImage(cvPixelBuffer: pixelBuffer)
      .oriented(forExifOrientation: Int32(orientation.rawValue))
    let extent = source.extent
    let detectedRect = CGRect(
      x: extent.minX + faceBounds.minX * extent.width,
      y: extent.minY + faceBounds.minY * extent.height,
      width: faceBounds.width * extent.width,
      height: faceBounds.height * extent.height
    )
    let side = min(max(detectedRect.width, detectedRect.height) * 1.25, extent.width, extent.height)
    guard side > 1 else { return nil }

    let center = CGPoint(x: detectedRect.midX, y: detectedRect.midY)
    let cropX = min(max(center.x - side / 2, extent.minX), extent.maxX - side)
    let cropY = min(max(center.y - side / 2, extent.minY), extent.maxY - side)
    let cropRect = CGRect(x: cropX, y: cropY, width: side, height: side)
    let normalizedCrop = source
      .cropped(to: cropRect)
      .transformed(by: CGAffineTransform(translationX: -cropRect.minX, y: -cropRect.minY))
      .transformed(by: CGAffineTransform(scaleX: 112 / side, y: 112 / side))

    var pixels = [UInt8](repeating: 0, count: 112 * 112 * 4)
    imageContext.render(
      normalizedCrop,
      toBitmap: &pixels,
      rowBytes: 112 * 4,
      bounds: CGRect(x: 0, y: 0, width: 112, height: 112),
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    )

    var input = [Float]()
    var luminance = [Float]()
    input.reserveCapacity(112 * 112 * 3)
    luminance.reserveCapacity(112 * 112)
    for index in stride(from: 0, to: pixels.count, by: 4) {
      let red = Float(pixels[index])
      let green = Float(pixels[index + 1])
      let blue = Float(pixels[index + 2])
      input.append((red - 127.5) * 0.0078125)
      input.append((green - 127.5) * 0.0078125)
      input.append((blue - 127.5) * 0.0078125)
      luminance.append((0.299 * red + 0.587 * green + 0.114 * blue) / 255)
    }

    let brightness = luminance.reduce(0, +) / Float(luminance.count)
    var edgeTotal: Float = 0
    var edgeCount: Float = 0
    for y in 0..<112 {
      for x in 0..<112 {
        let index = y * 112 + x
        if x + 1 < 112 {
          edgeTotal += abs(luminance[index] - luminance[index + 1])
          edgeCount += 1
        }
        if y + 1 < 112 {
          edgeTotal += abs(luminance[index] - luminance[index + 112])
          edgeCount += 1
        }
      }
    }
    let sharpness = edgeCount > 0 ? edgeTotal / edgeCount : 0

    return embeddingLock.withLock {
      do {
        let inputData = input.withUnsafeBufferPointer { Data(buffer: $0) }
        try interpreter.copy(inputData, toInputAt: 0)
        try interpreter.invoke()
        let output = try interpreter.output(at: 0)
        let values = output.data.withUnsafeBytes { bytes in
          Array(bytes.bindMemory(to: Float.self))
        }
        let norm = sqrt(values.reduce(0) { $0 + $1 * $1 })
        guard norm.isFinite, norm > 0 else { return nil }
        return FaceEmbeddingOutput(
          embedding: values.map { $0 / norm },
          brightness: brightness,
          sharpness: sharpness
        )
      } catch {
        print("[FaceEmbedding] Inference failed: \(error)")
        return nil
      }
    }
  }
}

private extension NSLock {
  func withLock<T>(_ operation: () -> T) -> T {
    lock()
    defer { unlock() }
    return operation()
  }
}
