import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpToLine,
  Crosshair,
  FileVideo,
  LoaderCircle,
  Maximize,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  Search,
  Send,
  Settings,
  Sparkles,
  UploadCloud,
  Volume2,
} from "lucide-react";
import avatarUrl from "./assets/avatar.png";
import videoFeedUrl from "./assets/video-feed.png";

const VSS_UI_URL = import.meta.env.VITE_VSS_UI_URL ?? "http://172.16.95.171:7777";
const VSS_AGENT_API_URL =
  import.meta.env.VITE_VSS_AGENT_API_URL ?? "http://172.16.95.171:8000";
const VSS_UPLOAD_API_URL =
  import.meta.env.VITE_VSS_UPLOAD_API_URL ?? `${VSS_UI_URL}/api/v1`;
const VSS_VST_API_URL =
  import.meta.env.VITE_VSS_VST_API_URL ?? `${VSS_UI_URL}/vst/api/v1`;
const CLIP_LEAD_IN_SECONDS = 4;
const CLIP_DURATION_SECONDS = 18;
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_TIMESTAMP = "2025-01-01T00:00:00";
const HISTORY_STORAGE_KEY = "surgeseek-upload-history";
const DEFAULT_VSS_SYSTEM_PROMPT =
  'You are a video expert. Make sure to judge your response to the question. Do not ask for the video id if I ask you to find videos or list videos. The output format must be JSON with this shape: {"answers":[{"video_id":"to-be-filled","reasoning":"your final thoughts or summary of your thoughts to the given question/task below","score":0.0}]}. The score is for every task. If returning multiple videos, return a list of answers. The video_id is the name of the video in the database. This is to help assist medical staff judgement.';
const VSS_SYSTEM_PROMPT =
  import.meta.env.VITE_VSS_SYSTEM_PROMPT ?? DEFAULT_VSS_SYSTEM_PROMPT;

const TEST_VIDEO_ANSWER = {
  video_id: "LapSmallBowelResectionSurgery-rdInwPkuE6w",
  reasoning:
    "Hard-coded test video for validating VSS playback from the Search Videos UI.",
  score: 0.95,
};

function App() {
  const [activeTab, setActiveTab] = useState("upload");
  const [videoFile, setVideoFile] = useState(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState("");
  const [collection, setCollection] = useState("");
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [recentVideos, setRecentVideos] = useState(() => readStoredUploadHistory());
  const [prompt, setPrompt] = useState("");
  const [topK, setTopK] = useState(5);
  const [searchStatus, setSearchStatus] = useState("idle");
  const [searchResult, setSearchResult] = useState(null);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);

  useEffect(() => {
    persistUploadHistory(recentVideos);
  }, [recentVideos]);

  useEffect(() => {
    let ignore = false;

    async function loadVssHistory() {
      try {
        const response = await fetch(`${VSS_VST_API_URL.replace(/\/$/, "")}/sensor/list`);
        const sensors = await parseResponse(response);
        if (!response.ok || !Array.isArray(sensors) || ignore) return;

        const sensorVideos = sensors
          .filter((sensor) => sensor?.state !== "removed")
          .map(videoHistoryRowFromSensor)
          .filter(Boolean);

        if (sensorVideos.length > 0) {
          setRecentVideos((current) => mergeVideoHistory(sensorVideos, current));
        }
      } catch {
        // Keep the locally persisted upload history if VSS is unavailable.
      }
    }

    loadVssHistory();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleUpload(event) {
    event.preventDefault();
    if (!videoFile) return;

    const uploadStartedAt = new Date().toISOString();
    const localHistoryId = `${videoFile.name}-${uploadStartedAt}`;
    const baseHistoryRow = videoHistoryRowFromFile(videoFile, {
      id: localHistoryId,
      uploadedAt: uploadStartedAt,
      status: "Processing",
    });

    setUploadStatus("loading");
    setUploadResult(null);
    setUploadProgress(0);
    setRecentVideos((current) => mergeVideoHistory([baseHistoryRow], current));

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
      setRecentVideos((current) =>
        mergeVideoHistory(
          [
            {
              ...baseHistoryRow,
              id: sensorId,
              status: "Indexed",
            },
          ],
          current,
        ),
      );
      setUploadProgress(100);
      setUploadStatus("success");
    } catch (error) {
      setUploadResult({ error: error.message });
      setRecentVideos((current) =>
        mergeVideoHistory([{ ...baseHistoryRow, status: "Failed" }], current),
      );
      setUploadStatus("error");
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (!prompt.trim()) return;

    setSearchStatus("loading");
    setSearchResult(null);
    setSelectedSearchIndex(0);

    try {
      const response = await fetch(`${VSS_AGENT_API_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_message: buildVssAgentPrompt(prompt, topK),
        }),
      });
      const data = await parseResponse(response);
      if (!response.ok) {
        throw new Error(JSON.stringify(data.detail ?? data));
      }
      setSearchResult(normalizeSearchResult(data));
      setSelectedSearchIndex(0);
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
    setUploadProgress(0);

    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }

    setVideoPreviewUrl(file ? URL.createObjectURL(file) : "");
  }

  const activeFileName = videoFile?.name ?? "No video selected";
  const visibleProgress =
    uploadStatus === "loading" ? uploadProgress : uploadStatus === "success" ? 100 : 0;

  return (
    <main className="app-shell">
      <Header activeTab={activeTab} setActiveTab={setActiveTab} />

      {activeTab === "upload" ? (
        <UploadScreen
          activeFileName={activeFileName}
          collection={collection}
          handleUpload={handleUpload}
          handleVideoSelect={handleVideoSelect}
          setCollection={setCollection}
          uploadProgress={visibleProgress}
          uploadResult={uploadResult}
          uploadStatus={uploadStatus}
          videoFile={videoFile}
          videoPreviewUrl={videoPreviewUrl}
          recentVideos={recentVideos}
        />
      ) : (
        <SearchScreen
          handleSearch={handleSearch}
          prompt={prompt}
          searchResult={searchResult}
          searchStatus={searchStatus}
          selectedSearchIndex={selectedSearchIndex}
          setSelectedSearchIndex={setSelectedSearchIndex}
          setPrompt={setPrompt}
          setTopK={setTopK}
          topK={topK}
        />
      )}
    </main>
  );
}

function Header({ activeTab, setActiveTab }) {
  return (
    <header className="top-bar">
      <div className="brand-lockup">
        <div className="logo-mark">
          <Crosshair size={17} aria-hidden="true" />
        </div>
        <strong>SurgeSeek</strong>
        <span>Clinical OS</span>
      </div>

      <nav className="tab-list" aria-label="SurgeSeek workflows">
        <button
          aria-selected={activeTab === "upload"}
          className="tab-button"
          type="button"
          onClick={() => setActiveTab("upload")}
        >
          <ArrowUpToLine size={16} aria-hidden="true" />
          <span>Upload Video</span>
        </button>
        <button
          aria-selected={activeTab === "search"}
          className="tab-button"
          type="button"
          onClick={() => setActiveTab("search")}
        >
          <Search size={16} aria-hidden="true" />
          <span>Search Videos</span>
        </button>
      </nav>

      <div className="user-profile">
        <span>OR 04-ACTIVE</span>
        <img alt="" src={avatarUrl} />
      </div>
    </header>
  );
}

function UploadScreen({
  activeFileName,
  collection,
  handleUpload,
  handleVideoSelect,
  setCollection,
  uploadProgress,
  uploadResult,
  uploadStatus,
  videoFile,
  videoPreviewUrl,
  recentVideos,
}) {
  return (
    <form className="upload-workspace" onSubmit={handleUpload}>
      <label className={`upload-dropzone ${videoFile ? "has-file" : ""}`}>
        <input
          accept="video/*"
          type="file"
          onChange={(event) => handleVideoSelect(event.target.files?.[0] ?? null)}
        />
        {videoPreviewUrl ? (
          <video controls src={videoPreviewUrl} />
        ) : (
          <div className="upload-empty">
            <span className="upload-icon">
              <UploadCloud size={32} aria-hidden="true" />
            </span>
            <strong>Drag & drop your surgical video here</strong>
            <span>
              or <em>browse files</em>
            </span>
            <small>SUPPORTED FORMATS: MP4, AVI, MOV (MAX 5GB)</small>
          </div>
        )}
      </label>

      <section className="processing-card" aria-label="Upload processing status">
        <div className="processing-row">
          <div className="file-info">
            <FileVideo size={20} aria-hidden="true" />
            <strong title={activeFileName}>{activeFileName}</strong>
            <span>{formatFileSize(videoFile?.size) || "Select a file"}</span>
          </div>
          <div className="processing-status">
            <strong>{statusCopy(uploadStatus, uploadProgress)}</strong>
            <span>
              {uploadStatus === "idle"
                ? "Waiting for file"
                : uploadStatus === "loading"
                  ? "EST: calculating"
                  : uploadStatus === "success"
                    ? "Ready for search"
                    : "Upload did not complete"}
            </span>
          </div>
        </div>
        <div className="progress-track" aria-label="Upload progress">
          <span style={{ width: `${uploadProgress}%` }} />
        </div>
      </section>

      <section className="upload-actions" aria-label="Upload controls">
        <label className="field">
          <span>Collection</span>
          <input
            placeholder="default"
            type="text"
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
          />
        </label>
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
      </section>

      <section className="history-section" aria-label="Recently uploaded videos">
        <h2>Recently Uploaded Videos</h2>
        <div className="history-table">
          <div className="table-row table-head">
            <span>File Name</span>
            <span>File Size</span>
            <span>Upload Date</span>
            <span>Status</span>
          </div>
          {recentVideos.length > 0 ? (
            recentVideos.map((video) => (
              <div className="table-row" key={video.id ?? `${video.name}-${video.uploadedAt}`}>
                <span className="name-cell">
                  <span className="film-thumb">
                    <FileVideo size={14} aria-hidden="true" />
                  </span>
                  <strong title={video.name}>{video.name}</strong>
                </span>
                <span>{video.size}</span>
                <span>{video.date}</span>
                <span>
                  <em className={`status-badge ${statusClassName(video.status)}`}>
                    {video.status}
                  </em>
                </span>
              </div>
            ))
          ) : (
            <div className="table-row empty-row">
              <span>No uploaded videos yet</span>
              <span>-</span>
              <span>-</span>
              <span>
                <em className="status-badge idle">Ready</em>
              </span>
            </div>
          )}
        </div>
      </section>

      <ResultBlock status={uploadStatus} result={uploadResult} />
    </form>
  );
}

function SearchScreen({
  handleSearch,
  prompt,
  searchResult,
  searchStatus,
  selectedSearchIndex,
  setSelectedSearchIndex,
  setPrompt,
  setTopK,
  topK,
}) {
  const playerRef = useRef(null);
  const [selectedVideoUrl, setSelectedVideoUrl] = useState("");
  const [playerStatus, setPlayerStatus] = useState("idle");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const searchAnswers = useMemo(() => normalizeAnswers(searchResult), [searchResult]);
  const hasSearchAnswers = searchAnswers.length > 0;
  const visibleMatches = hasSearchAnswers ? searchAnswers : [TEST_VIDEO_ANSWER];
  const activeMatchIndex = hasSearchAnswers
    ? Math.min(selectedSearchIndex, searchAnswers.length - 1)
    : 0;
  const selectedAnswer = visibleMatches[activeMatchIndex] ?? null;

  useEffect(() => {
    const controller = new AbortController();

    async function resolveSelectedVideo() {
      if (!selectedAnswer) {
        setSelectedVideoUrl("");
        setPlayerStatus("idle");
        return;
      }

      setSelectedVideoUrl("");
      setPlayerStatus("loading");
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);

      try {
        const playbackUrl = await resolveVssPlaybackUrl(selectedAnswer, controller.signal);
        setSelectedVideoUrl(playbackUrl);
        setPlayerStatus(playbackUrl ? "ready" : "error");
      } catch (error) {
        if (error.name === "AbortError") return;
        setSelectedVideoUrl("");
        setPlayerStatus("error");
      }
    }

    resolveSelectedVideo();
    return () => controller.abort();
  }, [selectedAnswer]);

  async function handleTogglePlayback() {
    const player = playerRef.current;
    if (!player || !selectedVideoUrl) return;

    if (player.paused) {
      try {
        await player.play();
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    player.pause();
  }

  function handleSeek(event) {
    const nextTime = Number(event.target.value);
    const player = playerRef.current;
    setCurrentTime(nextTime);
    if (player) player.currentTime = nextTime;
  }

  function handlePlaybackRateChange(event) {
    const nextRate = Number(event.target.value);
    setPlaybackRate(nextRate);
    if (playerRef.current) playerRef.current.playbackRate = nextRate;
  }

  function handleLoadedMetadata(event) {
    setDuration(event.currentTarget.duration || 0);
    event.currentTarget.playbackRate = playbackRate;
  }

  function handleTimeUpdate(event) {
    setCurrentTime(event.currentTarget.currentTime || 0);
  }

  function handleFullscreen() {
    playerRef.current?.requestFullscreen?.();
  }

  return (
    <form className="search-workspace" onSubmit={handleSearch}>
      <section className="chat-panel">
        <header className="chat-header">
          <div>
            <MessageSquareText size={18} aria-hidden="true" />
            <strong>Surgical Assistant AI</strong>
          </div>
          <span className="online-pill">ONLINE</span>
        </header>

        <div className="chat-thread">
          <ChatMessage sender="USER | 14:02">
            Where is the cystic artery clipped?
          </ChatMessage>
          <ChatMessage sender="SURGESEEK | 14:03" ai>
            <p>
              The cystic artery is isolated and successfully double-clipped in
              the hepatocystic triangle during the dissection phase.
            </p>
            <div className="match-reference">
              <div>
                <strong>TOP MATCH</strong>
                <span>98% Match</span>
              </div>
              <p>Cystic artery isolated & double-clipped</p>
            </div>
          </ChatMessage>
          <ChatMessage sender="USER | 14:05">
            Show me the critical view of safety
          </ChatMessage>
          {searchStatus !== "idle" ? (
            <ChatMessage sender="SURGESEEK | NOW" ai>
              <SearchResultSummary status={searchStatus} result={searchResult} />
            </ChatMessage>
          ) : null}
        </div>

        <div className="chat-input-bar">
          <label className="search-input">
            <input
              placeholder="Ask about anatomy, clips, steps..."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <Mic size={16} aria-hidden="true" />
          </label>
          <label className="topk-input">
            <span>Results</span>
            <input
              min="1"
              max="25"
              type="number"
              value={topK}
              onChange={(event) => setTopK(event.target.value)}
            />
          </label>
          <button
            aria-label="Send prompt"
            className="send-button"
            disabled={!prompt.trim() || searchStatus === "loading"}
            type="submit"
          >
            {searchStatus === "loading" ? (
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
            ) : (
              <Send size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </section>

      <section className="visuals-panel">
        <div className="video-player-card">
          <div className="video-feed">
            {selectedVideoUrl ? (
              <video
                key={selectedVideoUrl}
                ref={playerRef}
                poster={videoFeedUrl}
                src={selectedVideoUrl}
                onEnded={() => setIsPlaying(false)}
                onLoadedMetadata={handleLoadedMetadata}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onTimeUpdate={handleTimeUpdate}
              />
            ) : (
              <img alt="" src={videoFeedUrl} />
            )}
            <div className="video-pills">
              <span>{selectedAnswer ? "MATCH" : "CAM 01"}</span>
              <span>{selectedAnswer?.video_id ?? "1080p"}</span>
            </div>
            {selectedAnswer && playerStatus !== "ready" ? (
              <div className="video-status">
                {playerStatus === "loading" ? "Resolving VSS stream..." : "VSS stream unavailable"}
              </div>
            ) : null}
            <button
              aria-label={isPlaying ? "Pause selected video" : "Play selected video"}
              className="play-button"
              disabled={!selectedVideoUrl}
              type="button"
              onClick={handleTogglePlayback}
            >
              {isPlaying ? (
                <Pause size={24} aria-hidden="true" />
              ) : (
                <Play size={24} aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="player-controls">
            <label className="scrub-control">
              <span>{formatPlaybackTime(currentTime)}</span>
              <input
                aria-label="Seek video"
                disabled={!selectedVideoUrl || !duration}
                max={duration || 0}
                min="0"
                step="0.1"
                type="range"
                value={Math.min(currentTime, duration || 0)}
                onChange={handleSeek}
              />
              <span>{formatPlaybackTime(duration)}</span>
            </label>
            <div className="controls-row">
              <div>
                <button
                  aria-label={isPlaying ? "Pause video" : "Play video"}
                  disabled={!selectedVideoUrl}
                  type="button"
                  onClick={handleTogglePlayback}
                >
                  {isPlaying ? (
                    <Pause size={18} aria-hidden="true" />
                  ) : (
                    <Play size={18} aria-hidden="true" />
                  )}
                </button>
                <Volume2 size={18} aria-hidden="true" />
              </div>
              <div>
                <label className="speed-control">
                  <Settings size={16} aria-hidden="true" />
                  <select
                    aria-label="Playback speed"
                    disabled={!selectedVideoUrl}
                    value={playbackRate}
                    onChange={handlePlaybackRateChange}
                  >
                    <option value="0.5">0.5x</option>
                    <option value="0.75">0.75x</option>
                    <option value="1">1x</option>
                    <option value="1.25">1.25x</option>
                    <option value="1.5">1.5x</option>
                    <option value="2">2x</option>
                  </select>
                </label>
                <button
                  aria-label="Fullscreen video"
                  disabled={!selectedVideoUrl}
                  type="button"
                  onClick={handleFullscreen}
                >
                  <Maximize size={18} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="matches-card">
          <header>
            <h2>Query Matches inside Video</h2>
            <span>{visibleMatches.length} INSTANCES FOUND</span>
          </header>
          <div className="matches-stack">
            {visibleMatches.map((match, index) => (
              <button
                aria-pressed={index === activeMatchIndex}
                className={`match-item ${index === activeMatchIndex ? "active" : ""}`}
                key={match.video_id ?? match.title}
                type="button"
                onClick={() => {
                  if (hasSearchAnswers) setSelectedSearchIndex(index);
                }}
              >
                <div className="match-copy">
                  <strong>{match.video_id ?? match.title}</strong>
                  {match.reasoning ? (
                    <p>{match.reasoning}</p>
                  ) : (
                    <span>
                      {match.tags.map((tag) => (
                        <em key={tag}>{tag}</em>
                      ))}
                    </span>
                  )}
                </div>
                <div className="match-score">
                  <strong>{formatScore(match.score)}</strong>
                  <span>CONFIDENCE</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>
    </form>
  );
}

async function resolveVssPlaybackUrl(answer, signal) {
  const directUrl =
    answer.video_url ??
    answer.videoUrl ??
    answer.playback_url ??
    answer.playbackUrl ??
    answer.url;
  if (directUrl) return withStartTime(resolveVssUrl(directUrl), extractStartTime(answer));

  const streamId = await resolveVssStreamId(answer.video_id, signal);
  if (!streamId) return "";

  const timeline = await resolveVssTimeline(streamId, signal);
  const clipRange = buildClipRange(timeline, extractStartTime(answer));
  if (!clipRange) return "";

  const clipUrl = new URL(`${VSS_VST_API_URL.replace(/\/$/, "")}/storage/file/${encodeURIComponent(streamId)}/url`);
  clipUrl.searchParams.set("startTime", clipRange.startTime);
  clipUrl.searchParams.set("endTime", clipRange.endTime);
  clipUrl.searchParams.set("container", "mp4");
  clipUrl.searchParams.set("disableAudio", "true");
  clipUrl.searchParams.set("expiryMinutes", "30");

  const response = await fetch(clipUrl, { signal });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(JSON.stringify(data.error_message ?? data.detail ?? data));
  }

  return data.videoUrl ? resolveVssUrl(data.videoUrl) : "";
}

async function resolveVssStreamId(videoId, signal) {
  if (!videoId) return "";

  const response = await fetch(`${VSS_VST_API_URL.replace(/\/$/, "")}/sensor/list`, {
    signal,
  });
  const sensors = await parseResponse(response);
  if (!response.ok || !Array.isArray(sensors)) return videoId;

  const normalizedVideoId = normalizeVideoName(videoId);
  const sensor = sensors.find((candidate) => {
    if (candidate.state === "removed") return false;
    return [
      candidate.sensorId,
      candidate.name,
      stripVideoExtension(candidate.location),
      stripVideoExtension(candidate.url),
      stripVideoExtension(candidate.vodUrl),
    ].some((value) => normalizeVideoName(value) === normalizedVideoId);
  });

  return sensor?.sensorId ?? videoId;
}

async function resolveVssTimeline(streamId, signal) {
  const response = await fetch(
    `${VSS_VST_API_URL.replace(/\/$/, "")}/storage/${encodeURIComponent(streamId)}/timelines`,
    { signal },
  );
  const timelines = await parseResponse(response);
  if (!response.ok || !Array.isArray(timelines) || timelines.length === 0) return null;

  return timelines[0];
}

function buildClipRange(timeline, matchTimeSeconds) {
  if (!timeline?.startTime || !timeline?.endTime) return null;

  const timelineStart = new Date(timeline.startTime).getTime();
  const timelineEnd = new Date(timeline.endTime).getTime();
  if (!Number.isFinite(timelineStart) || !Number.isFinite(timelineEnd)) return null;

  const offsetMs = Number.isFinite(matchTimeSeconds) ? matchTimeSeconds * 1000 : 0;
  const leadInMs = CLIP_LEAD_IN_SECONDS * 1000;
  const durationMs = CLIP_DURATION_SECONDS * 1000;
  const latestStartMs = Math.max(timelineStart, timelineEnd - 1000);
  const startMs = Math.min(
    Math.max(timelineStart, timelineStart + offsetMs - leadInMs),
    latestStartMs,
  );
  const endMs = Math.min(Math.max(startMs + 1000, startMs + durationMs), timelineEnd);

  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

function normalizeAnswers(result) {
  if (!Array.isArray(result?.answers)) return [];

  return result.answers
    .filter((answer) => answer && typeof answer === "object")
    .map((answer) => ({
      ...answer,
      video_id: answer.video_id ?? answer.videoId ?? answer.id ?? "",
    }));
}

function extractStartTime(answer) {
  const explicitTime =
    answer.start_time ??
    answer.startTime ??
    answer.timestamp ??
    answer.time_seconds ??
    answer.timeSeconds;
  if (Number.isFinite(Number(explicitTime))) return Number(explicitTime);

  const reasoningMatch = String(answer.reasoning ?? "").match(
    /(?:approximately|around|at)?\s*(\d+(?:\.\d+)?)\s*(?:seconds|second|secs|sec|s)\b/i,
  );
  return reasoningMatch ? Number(reasoningMatch[1]) : null;
}

function withStartTime(url, startTime) {
  if (!Number.isFinite(startTime) || startTime <= 0) return url;
  return `${url}#t=${startTime}`;
}

function normalizeVideoName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stripVideoExtension(value) {
  if (!value) return "";
  const fileName = String(value).split("/").pop() ?? "";
  return fileName.replace(/\.(mp4|mov|avi|mkv|webm)$/i, "");
}

function formatScore(score) {
  if (typeof score === "string") return score;
  if (!Number.isFinite(Number(score))) return "N/A";
  const value = Number(score);
  return value <= 1 ? `${Math.round(value * 100)}%` : `${Math.round(value)}%`;
}

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";

  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function ChatMessage({ ai = false, children, sender }) {
  return (
    <article className={`chat-message ${ai ? "ai" : ""}`}>
      <span className="sender-line">
        {ai ? <Sparkles size={12} aria-hidden="true" /> : null}
        {sender}
      </span>
      <div className="message-box">{children}</div>
    </article>
  );
}

function SearchResultSummary({ result, status }) {
  if (status === "loading") {
    return <p>Searching the indexed archive...</p>;
  }

  if (status === "error") {
    return <p>{result?.error ?? "Search failed."}</p>;
  }

  return <pre className="inline-result">{JSON.stringify(result, null, 2)}</pre>;
}

function ResultBlock({ status, result }) {
  if (status === "idle" || status === "loading" || !result) {
    return null;
  }

  return (
    <div className={`result-block ${status}`}>
      <p>{status === "success" ? "Response" : "Needs review"}</p>
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

function buildVssAgentPrompt(userPrompt, topK) {
  return [
    `SYSTEM_PROMPT: ${VSS_SYSTEM_PROMPT}`,
    `QUESTION_TASK: ${userPrompt.trim()}`,
    `RETURN_LIMIT: Return up to ${Number(topK)} videos from the indexed VSS video archive.`,
    "Return only valid JSON. Do not wrap the JSON in markdown.",
  ].join("\n\n");
}

function normalizeSearchResult(data) {
  return extractAnswersPayload(data) ?? data;
}

function extractAnswersPayload(value) {
  if (!value) return null;

  if (Array.isArray(value.answers)) {
    return { answers: value.answers };
  }

  if (typeof value === "string") {
    return parseAnswersJson(value);
  }

  if (typeof value === "object") {
    const candidates = [
      value.response,
      value.output,
      value.result,
      value.text,
      value.message,
      value.generated_text,
      value.generatedText,
      value.answer,
    ];

    for (const candidate of candidates) {
      const payload = extractAnswersPayload(candidate);
      if (payload) return payload;
    }
  }

  return null;
}

function parseAnswersJson(text) {
  try {
    return extractAnswersPayload(JSON.parse(text));
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*"answers"[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      return extractAnswersPayload(JSON.parse(jsonMatch[0]));
    } catch {
      return null;
    }
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
      file,
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

function readStoredUploadHistory() {
  try {
    const value = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    const videos = JSON.parse(value ?? "[]");
    return Array.isArray(videos) ? videos.filter(isVideoHistoryRow).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function persistUploadHistory(videos) {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(videos.slice(0, 20)));
  } catch {
    // History is an enhancement; uploads should keep working without localStorage.
  }
}

function videoHistoryRowFromFile(file, { id, status, uploadedAt }) {
  return {
    id,
    name: file.name,
    size: formatFileSize(file.size) || "Unknown",
    date: formatUploadDate(uploadedAt),
    uploadedAt,
    status,
  };
}

function videoHistoryRowFromSensor(sensor) {
  const name = sensor.name ?? fileNameFromPath(sensor.location ?? sensor.url ?? sensor.vodUrl);
  if (!name) return null;

  const uploadedAt =
    sensor.createdAt ??
    sensor.created_at ??
    sensor.updatedAt ??
    sensor.updated_at ??
    sensor.startTime ??
    sensor.start_time ??
    new Date().toISOString();

  return {
    id: sensor.sensorId ?? sensor.id ?? name,
    name,
    size: formatFileSize(
      sensor.fileSize ??
        sensor.file_size ??
        sensor.size ??
        sensor.bytes ??
        sensor.file_size_bytes,
    ) || "Unknown",
    date: formatUploadDate(uploadedAt),
    uploadedAt,
    status: normalizeHistoryStatus(sensor.status ?? sensor.state),
  };
}

function mergeVideoHistory(incomingVideos, currentVideos) {
  const merged = new Map();

  [...incomingVideos, ...currentVideos].filter(isVideoHistoryRow).forEach((video) => {
    const key = normalizeVideoName(video.name) || normalizeVideoName(video.id);
    const existing = merged.get(key);
    merged.set(key, {
      ...existing,
      ...video,
      size: video.size === "Unknown" && existing?.size ? existing.size : video.size,
      uploadedAt: video.uploadedAt ?? existing?.uploadedAt,
      date: video.date ?? existing?.date,
    });
  });

  return Array.from(merged.values())
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .slice(0, 20);
}

function isVideoHistoryRow(video) {
  return Boolean(video?.name && video?.date && video?.status);
}

function fileNameFromPath(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), VSS_UI_URL);
    return decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    return String(value).split(/[?#]/)[0].split("/").pop() ?? "";
  }
}

function formatUploadDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function normalizeHistoryStatus(value) {
  const status = String(value ?? "").toLowerCase();

  if (status.includes("fail") || status.includes("error")) return "Failed";
  if (status.includes("process") || status.includes("upload") || status.includes("pending")) {
    return "Processing";
  }
  return "Indexed";
}

function statusClassName(status) {
  return normalizeHistoryStatus(status).toLowerCase();
}

function statusCopy(status, progress) {
  if (status === "loading") return `PROCESSING: ${progress}%`;
  if (status === "success") return "INDEXED: 100%";
  if (status === "error") return "FAILED";
  return "READY TO UPLOAD";
}

function formatFileSize(size) {
  if (!size) return "";

  if (typeof size === "string" && !Number.isFinite(Number(size))) {
    return size;
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export default App;
