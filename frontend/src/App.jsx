import { useState } from "react";
import {
  FileVideo,
  LoaderCircle,
  Search,
  Send,
  Server,
  UploadCloud,
} from "lucide-react";

const VSS_UI_URL = import.meta.env.VITE_VSS_UI_URL ?? "http://172.16.95.171:7777";
const VSS_AGENT_API_URL =
  import.meta.env.VITE_VSS_AGENT_API_URL ?? "http://172.16.95.171:8000";
const VSS_UPLOAD_API_URL =
  import.meta.env.VITE_VSS_UPLOAD_API_URL ?? `${VSS_UI_URL}/api/v1`;
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_TIMESTAMP = "2025-01-01T00:00:00";

function App() {
  const [activeTab, setActiveTab] = useState("upload");
  const [videoFile, setVideoFile] = useState(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState("");
  const [collection, setCollection] = useState("");
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [topK, setTopK] = useState(5);
  const [searchStatus, setSearchStatus] = useState("idle");
  const [searchResult, setSearchResult] = useState(null);

  async function handleUpload(event) {
    event.preventDefault();
    if (!videoFile) return;

    setUploadStatus("loading");
    setUploadResult(null);
    setUploadProgress(0);

    try {
      const uploadName = videoFile.name;
      const uploadUrlResponse = await fetch(`${VSS_UPLOAD_API_URL}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadName }),
      });

      const uploadUrlData = await parseResponse(uploadUrlResponse);
      if (!uploadUrlResponse.ok) {
        throw new Error(JSON.stringify(uploadUrlData.detail ?? uploadUrlData));
      }

      const chunkData = await uploadFileToVss({
        file: videoFile,
        fileName: uploadName,
        uploadUrl: resolveVssUrl(uploadUrlData.url),
        onProgress: setUploadProgress,
      });

      const sensorId =
        extractSensorId(chunkData) ??
        extractSensorId(uploadUrlData) ??
        extractSensorIdFromUrl(uploadUrlData.url);
      if (!sensorId) {
        throw new Error(
          `Upload succeeded but VSS did not return a sensor id: ${JSON.stringify(chunkData)}`,
        );
      }

      const completeResponse = await fetch(
        `${VSS_UPLOAD_API_URL}/videos/${encodeURIComponent(sensorId)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...chunkData,
            filename: uploadName,
            custom_params: collection.trim()
              ? { collection: collection.trim() }
              : undefined,
          }),
        },
      );

      const completeData = await parseResponse(completeResponse);
      if (!completeResponse.ok) {
        throw new Error(JSON.stringify(completeData.detail ?? completeData));
      }

      setUploadResult({
        status: "uploaded",
        upload_url: uploadUrlData.url,
        vst_upload_response: chunkData,
        complete_response: completeData,
      });
      setUploadProgress(100);
      setUploadStatus("success");
    } catch (error) {
      setUploadResult({ error: error.message });
      setUploadStatus("error");
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (!prompt.trim()) return;

    setSearchStatus("loading");
    setSearchResult(null);

    try {
      const response = await fetch(`${VSS_AGENT_API_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_message: `${prompt.trim()}\n\nReturn up to ${Number(topK)} search results from the indexed VSS video archive.`,
        }),
      });
      const data = await parseResponse(response);
      if (!response.ok) {
        throw new Error(JSON.stringify(data.detail ?? data));
      }
      setSearchResult(data);
      setSearchStatus("success");
    } catch (error) {
      setSearchResult({ error: error.message });
      setSearchStatus("error");
    }
  }

  function handleVideoSelect(file) {
    setVideoFile(file);
    setUploadResult(null);
    setUploadStatus("idle");

    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }

    setVideoPreviewUrl(file ? URL.createObjectURL(file) : "");
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">VSS Hackathon Console</p>
          <h1>Video intelligence workspace</h1>
        </div>
        <div className="server-pill">
          <Server size={16} aria-hidden="true" />
          <span>VSS direct</span>
          <strong>{new URL(VSS_UI_URL).host}</strong>
        </div>
      </header>

      <section className="workspace-shell" aria-label="VSS actions">
        <div className="tab-list" role="tablist" aria-label="VSS workflows">
          <button
            aria-controls="upload-panel"
            aria-selected={activeTab === "upload"}
            className="tab-button"
            id="upload-tab"
            role="tab"
            type="button"
            onClick={() => setActiveTab("upload")}
          >
            <UploadCloud size={18} aria-hidden="true" />
            <span>Upload Video</span>
          </button>
          <button
            aria-controls="search-panel"
            aria-selected={activeTab === "search"}
            className="tab-button"
            id="search-tab"
            role="tab"
            type="button"
            onClick={() => setActiveTab("search")}
          >
            <Search size={18} aria-hidden="true" />
            <span>Query Search</span>
          </button>
        </div>

        {activeTab === "upload" ? (
          <form
            aria-labelledby="upload-tab"
            className="panel video-panel"
            id="upload-panel"
            role="tabpanel"
            onSubmit={handleUpload}
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Video ingest</p>
                <h2>Upload to VSS</h2>
              </div>
              <span className={`status-chip ${uploadStatus}`}>{statusLabel(uploadStatus)}</span>
            </div>

            <label className={`drop-zone ${videoFile ? "has-file" : ""}`}>
              <input
                accept="video/*"
                type="file"
                onChange={(event) =>
                  handleVideoSelect(event.target.files?.[0] ?? null)
                }
              />
              {videoPreviewUrl ? (
                <video controls src={videoPreviewUrl} />
              ) : (
                <div className="drop-zone-empty">
                  <UploadCloud size={34} aria-hidden="true" />
                  <strong>Select a video file</strong>
                  <span>MP4, MOV, or browser-supported video formats</span>
                </div>
              )}
            </label>

            <div className="video-details">
              <div className="file-summary">
                <FileVideo size={20} aria-hidden="true" />
                <div>
                  <span>{videoFile?.name ?? "No file selected"}</span>
                  <strong>{formatFileSize(videoFile?.size)}</strong>
                </div>
              </div>

              <label className="field">
                <span>Collection</span>
                <input
                  placeholder="default"
                  type="text"
                  value={collection}
                  onChange={(event) => setCollection(event.target.value)}
                />
              </label>
            </div>

            <button
              className="primary-action"
              disabled={!videoFile || uploadStatus === "loading"}
              type="submit"
            >
              {uploadStatus === "loading" ? (
                <LoaderCircle className="spin" size={18} aria-hidden="true" />
              ) : (
                <UploadCloud size={18} aria-hidden="true" />
              )}
              <span>{uploadStatus === "loading" ? "Uploading" : "Upload video"}</span>
            </button>

            {uploadStatus === "loading" ? (
              <div className="progress-track" aria-label="Upload progress">
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
            ) : null}

            <ResultBlock status={uploadStatus} result={uploadResult} />
          </form>
        ) : (
          <form
            aria-labelledby="search-tab"
            className="panel search-panel"
            id="search-panel"
            role="tabpanel"
            onSubmit={handleSearch}
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Search query</p>
                <h2>Ask VSS</h2>
              </div>
              <span className={`status-chip ${searchStatus}`}>{statusLabel(searchStatus)}</span>
            </div>

            <label className="field">
              <span>Prompt</span>
              <textarea
                placeholder="Find moments where a person enters the classroom"
                rows="6"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>

            <div className="query-toolbar">
              <label className="field compact-field">
                <span>Results</span>
                <input
                  min="1"
                  max="25"
                  type="number"
                  value={topK}
                  onChange={(event) => setTopK(event.target.value)}
                />
              </label>

              <div className="hint-strip">
                <Search size={18} aria-hidden="true" />
                <span>Semantic search across uploaded video events</span>
              </div>
            </div>

            <button
              className="primary-action"
              disabled={!prompt.trim() || searchStatus === "loading"}
              type="submit"
            >
              {searchStatus === "loading" ? (
                <LoaderCircle className="spin" size={18} aria-hidden="true" />
              ) : (
                <Send size={18} aria-hidden="true" />
              )}
              <span>{searchStatus === "loading" ? "Searching" : "Send prompt"}</span>
            </button>

            <ResultBlock status={searchStatus} result={searchResult} />
          </form>
        )}
      </section>
    </main>
  );
}

function ResultBlock({ status, result }) {
  if (status === "idle") {
    return <p className="muted-status">Ready for input.</p>;
  }

  return (
    <div className={`result-block ${status}`}>
      <p>{status === "success" ? "Response" : status}</p>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function uploadFileToVss({ file, fileName, uploadUrl, onProgress }) {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
  const uploadId = crypto.randomUUID();
  let lastResponse = null;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, file.size);
    const chunk = file.slice(start, end);

    lastResponse = await uploadVssChunk({
      chunk,
      fileName,
      uploadUrl,
      uploadId,
      chunkNumber: chunkIndex + 1,
      totalChunks,
      onProgress: (loaded) => {
        const completedBytes = chunkIndex * CHUNK_SIZE_BYTES + loaded;
        onProgress(Math.min(Math.round((completedBytes / file.size) * 100), 100));
      },
    });
  }

  if (!lastResponse) {
    throw new Error("Upload produced no response");
  }

  return lastResponse;
}

function uploadVssChunk({
  chunk,
  fileName,
  uploadUrl,
  uploadId,
  chunkNumber,
  totalChunks,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();

    formData.append("mediaFile", chunk, fileName);
    formData.append("filename", fileName);
    formData.append("metadata", JSON.stringify({ timestamp: UPLOAD_TIMESTAMP }));

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    });

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText));
        } catch {
          reject(new Error("Failed to parse VSS upload response"));
        }
        return;
      }

      reject(new Error(readUploadError(request)));
    });

    request.addEventListener("error", () => {
      reject(new Error("Network error during VSS upload"));
    });

    request.addEventListener("abort", () => {
      reject(new Error("VSS upload was cancelled"));
    });

    request.open("POST", uploadUrl);
    request.setRequestHeader("nvstreamer-chunk-number", String(chunkNumber));
    request.setRequestHeader("nvstreamer-total-chunks", String(totalChunks));
    request.setRequestHeader(
      "nvstreamer-is-last-chunk",
      String(chunkNumber === totalChunks),
    );
    request.setRequestHeader("nvstreamer-identifier", uploadId);
    request.setRequestHeader("nvstreamer-file-name", fileName);
    request.send(formData);
  });
}

function readUploadError(request) {
  try {
    const data = JSON.parse(request.responseText);
    return (
      data.error_message ??
      data.detail ??
      data.message ??
      `Upload failed with status ${request.status}`
    );
  } catch {
    return `Upload failed with status ${request.status}`;
  }
}

function resolveVssUrl(url) {
  return new URL(url, VSS_UI_URL).toString();
}

function extractSensorId(data) {
  return (
    data?.sensor_id ??
    data?.sensorId ??
    data?.sensorID ??
    data?.id ??
    data?.video_id ??
    data?.videoId
  );
}

function extractSensorIdFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match?.[1] ?? null;
}

function statusLabel(status) {
  const labels = {
    idle: "Ready",
    loading: "Working",
    success: "Complete",
    error: "Needs review",
  };

  return labels[status] ?? status;
}

function formatFileSize(size) {
  if (!size) return "Waiting for file";

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export default App;
