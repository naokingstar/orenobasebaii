let selectedVideo = null;
let videoId = null;
let analysis = null;

const playMap = {
  strikeout:"三振",
  hit:"ヒット",
  homerun:"ホームラン",
  timely:"タイムリーヒット",
  fineplay:"ファインプレー",
  score:"得点シーン",
  pitching:"投球シーン",
  batting:"打撃シーン",
  walk:"四球",
  unknown:"不明"
};

const subMap = {
  swinging_strikeout:"空振り三振",
  looking_strikeout:"見逃し三振",
  left_hit:"レフト前ヒット",
  center_hit:"センター前ヒット",
  right_hit:"ライト前ヒット",
  infield_hit:"内野安打",
  flyout:"フライアウト",
  groundout:"ゴロアウト",
  diving_catch:"ダイビングキャッチ",
  double_play:"ダブルプレー",
  great_throw:"好送球",
  home_run:"ホームラン",
  unknown:"不明"
};

document.getElementById("videoFile").addEventListener("change", function(e){
  const file = e.target.files[0];
  if(!file) return;
  selectedVideo = file;
  const url = URL.createObjectURL(file);
  const preview = document.getElementById("preview");
  preview.src = url;
  preview.style.display = "block";
  preview.onloadedmetadata = function(){
    document.getElementById("durationText").innerText = `動画の長さ：約${preview.duration.toFixed(1)}秒`;
  };
});

function startLoading(msg){
  const loading = document.getElementById("loading");
  const bar = document.getElementById("bar");
  const loadingText = document.getElementById("loadingText");
  loadingText.innerText = msg;
  loading.style.display = "block";
  bar.style.width = "0%";
  let p = 0;
  const timer = setInterval(() => {
    p += 1.2;
    if(p > 95) p = 95;
    bar.style.width = p + "%";
  }, 240);
  return timer;
}

function stopLoading(timer){
  clearInterval(timer);
  document.getElementById("bar").style.width = "100%";
  setTimeout(() => document.getElementById("loading").style.display = "none", 500);
}

async function analyzeVideo(){
  const errorArea = document.getElementById("errorArea");
  const confirmArea = document.getElementById("confirmArea");
  const resultArea = document.getElementById("resultArea");

  errorArea.style.display = "none";
  confirmArea.style.display = "none";
  resultArea.style.display = "none";

  if(!selectedVideo){
    alert("動画を選択してください。");
    return;
  }

  const fd = new FormData();
  fd.append("video", selectedVideo);

  const timer = startLoading("10枚の静止画を抽出し、AIが細かく解析しています...");

  try{
    const res = await fetch("/api/analyze", { method:"POST", body:fd });
    const data = await res.json();

    if(!res.ok) throw new Error(data.error || "解析に失敗しました。");

    stopLoading(timer);

    videoId = data.videoId;
    analysis = data.analysis || {};

    const candidates = Array.isArray(analysis.candidates)
      ? analysis.candidates.map(c => `・${playMap[c.playType] || c.playType}: ${subMap[c.subPlayType] || c.subPlayType || ""} ${c.confidence}%　${c.reason || ""}`).join("\n")
      : "候補なし";

    document.getElementById("analysisText").innerText =
      `最有力: ${playMap[analysis.bestPlayType] || analysis.bestPlayType || "unknown"}\n` +
      `細分化: ${subMap[analysis.subPlayType] || analysis.subPlayType || "unknown"}\n` +
      `信頼度: ${analysis.confidence ?? 0}%\n` +
      `概要: ${analysis.summary || ""}\n` +
      `実況ヒント: ${analysis.commentaryHint || ""}\n` +
      `注意点: ${analysis.warnings || ""}\n\n` +
      `候補:\n${candidates}\n\n` +
      `${data.needsConfirm ? "⚠️ 必ずプレー種類を確認してください。" : "✅ 比較的高信頼です。必要なら修正できます。"}`;

    const q = data.quality || {};
    document.getElementById("qualityText").innerText =
      `プレー認識：${q.recognition ?? 0}%\n` +
      `開始タイミング：${q.timing ?? 0}%\n` +
      `実況適合度：${q.fit ?? 0}%\n` +
      `総合：${q.grade || "C"}（${q.avg ?? 0}%）`;

    document.getElementById("confirmedPlayType").value = analysis.bestPlayType || "unknown";
    document.getElementById("confirmedSubPlayType").value = analysis.subPlayType || "unknown";

    if (analysis.bestStartTimeRatio !== undefined && data.duration) {
      document.getElementById("startTimeOverride").placeholder =
        `AI推定：約${(Number(data.duration) * Number(analysis.bestStartTimeRatio)).toFixed(1)}秒`;
    }

    confirmArea.style.display = "block";
    confirmArea.scrollIntoView({behavior:"smooth"});

  }catch(e){
    stopLoading(timer);
    errorArea.innerText = e.message;
    errorArea.style.display = "block";
  }
}

async function generateVideo(){
  const errorArea = document.getElementById("errorArea");
  const resultArea = document.getElementById("resultArea");

  errorArea.style.display = "none";
  resultArea.style.display = "none";

  if(!videoId){
    alert("先にAI映像解析してください。");
    return;
  }

  const timer = startLoading("実況文・音声・動画を生成しています...");

  try{
    const res = await fetch("/api/generate", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        videoId,
        style: document.getElementById("style").value,
        excitement: document.getElementById("excitement").value,
        voiceType: document.getElementById("voiceType").value,
        requestText: document.getElementById("requestText").value,
        confirmedPlayType: document.getElementById("confirmedPlayType").value,
        confirmedSubPlayType: document.getElementById("confirmedSubPlayType").value,
        startTimeOverride: document.getElementById("startTimeOverride").value
      })
    });

    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "生成に失敗しました。");

    stopLoading(timer);

    document.getElementById("confirmedText").innerText =
      `${playMap[data.confirmedPlayType] || data.confirmedPlayType} / ${subMap[data.confirmedSubPlayType] || data.confirmedSubPlayType}`;

    document.getElementById("resultText").innerText = data.commentary;
    document.getElementById("metaText").innerText =
      `動画長さ：約${Number(data.duration).toFixed(1)}秒 / 実況開始：約${Number(data.startTime).toFixed(1)}秒 / 残り：約${Number(data.remaining).toFixed(1)}秒`;

    document.getElementById("audioPlayer").src = data.audioUrl;
    document.getElementById("audioDownload").href = data.audioUrl;

    document.getElementById("resultVideo").src = data.videoUrl;
    document.getElementById("videoDownload").href = data.videoUrl;

    resultArea.style.display = "block";
    resultArea.scrollIntoView({behavior:"smooth"});

  }catch(e){
    stopLoading(timer);
    errorArea.innerText = e.message;
    errorArea.style.display = "block";
  }
}

async function regenerateOnly(){
  if(!videoId){
    alert("先にAI映像解析してください。");
    return;
  }
  await generateVideo();
}
