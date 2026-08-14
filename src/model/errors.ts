export class ModelNotReadyError extends Error {
  readonly code = 'MODEL_NOT_READY'

  constructor(modelId: string, detail = 'model is not installed or its integrity marker is invalid') {
    super(`Local model \"${modelId}\" is not ready: ${detail}`)
    this.name = 'ModelNotReadyError'
  }
}

export class ModelDownloadCancelledError extends Error {
  readonly code = 'MODEL_DOWNLOAD_CANCELLED'

  constructor(modelId: string) {
    super(`Local model download cancelled: ${modelId}`)
    this.name = 'ModelDownloadCancelledError'
  }
}

export class ModelDownloadError extends Error {
  readonly code = 'MODEL_DOWNLOAD_FAILED'

  constructor(modelId: string, detail: string, readonly cause?: unknown) {
    super(`Local model download failed for \"${modelId}\": ${detail}`)
    this.name = 'ModelDownloadError'
  }
}

export class ModelNotRunningError extends Error {
  readonly code = 'MODEL_NOT_RUNNING'

  constructor(modelId: string) {
    super(`Local model \"${modelId}\" is not running; explicitly start it before embedding`)
    this.name = 'ModelNotRunningError'
  }
}
