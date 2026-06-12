
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const outputsDir = path.join(__dirname, "outputs");
const framesDir = path.join(__dirname, "frames");

for (const d of [uploadsDir, outputsDir, framesDir]) fs.mkdirSync(d, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(outputsDir));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const videoStore = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname || ".mp4") || ".mp4"}`)
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("動画ファイルをアップロードしてください。"))
});

async function duration(file) {
  const { stdout } = await execFileAsync(ffprobeStatic.path, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ]);
  return Number(stdout.trim());
}

async function extractFrames(video, dur, id) {
  const ratios = [0.04, 0.12, 0.22, 0.32, 0.44, 0.56, 0.68, 0.80, 0.90, 0.97];
  const arr = [];
  for (let i = 0; i < ratios.length; i++) {
    const out = path.join(framesDir, `${id}-${i}.jpg`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss", String(Math.max(0.1, dur * ratios[i])),
      "-i", video,
      "-frames:v", "1",
      "-vf", "scale=720:-1",
      "-q:v", "4",
      out
    ]);
    arr.push(out);
  }
  return arr;
}

function dataUrl(p) {
  return "data:image/jpeg;base64," + fs.readFileSync(p).toString("base64");
}

async function analyze(frames) {
  const content = [{
    type: "text",
    text: `これは野球ショート動画から時系列で抽出した10枚の画像です。
目的は「実況で絶対に間違えないこと」です。

次を慎重に見てください。
- 空振りか、見逃しか、打球があるか
- 打者が走っているか
- 捕手が捕球しているか
- 投手や守備の反応
- 野手の送球や捕球
- ホームインや得点場面
- 打球方向が推定できるか

必ずJSONだけで回答してください。

形式:
{
  "bestPlayType":"strikeout|hit|homerun|timely|fineplay|score|pitching|batting|walk|unknown",
  "subPlayType":"swinging_strikeout|looking_strikeout|left_hit|center_hit|right_hit|infield_hit|flyout|groundout|diving_catch|double_play|great_throw|home_run|unknown",
  "confidence":0-100,
  "timingConfidence":0-100,
  "commentaryFitScore":0-100,
  "overallGrade":"S|A|B|C|D",
  "candidates":[
    {"playType":"strikeout|hit|homerun|timely|fineplay|score|pitching|batting|walk|unknown","subPlayType":"短い分類","confidence":0-100,"reason":"短い理由"}
  ],
  "summary":"日本語で短く",
  "bestStartTimeRatio":0.0-1.0,
  "commentaryHint":"実況生成に使う短い説明",
  "warnings":"断定できない点"
}

重要:
- 不明ならunknown
- 断定できない場合はconfidenceを低くする
- 三振/ヒット/ホームランを迷う場合は候補に全部出す
- subPlayTypeは分からなければunknown`
  }];

  for (const f of frames) {
    content.push({ type: "image_url", image_url: { url: dataUrl(f) } });
  }

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "あなたは野球映像を慎重に解析する専門家です。断定できない場合は必ず低信頼度にしてください。" },
      { role: "user", content }
    ],
    temperature: 0.1,
    max_tokens: 1000
  });

  const t = (r.choices?.[0]?.message?.content || "{}").trim().replace(/^```json|```$/g, "").trim();

  try {
    return JSON.parse(t);
  } catch {
    return {
      bestPlayType: "unknown",
      subPlayType: "unknown",
      confidence: 0,
      timingConfidence: 0,
      commentaryFitScore: 0,
      overallGrade: "D",
      candidates: [{ playType: "unknown", subPlayType: "unknown", confidence: 0, reason: "解析結果をJSONとして読み取れませんでした。" }],
      summary: "解析失敗",
      bestStartTimeRatio: 0.5,
      commentaryHint: t.slice(0, 200),
      warnings: "JSON解析失敗"
    };
  }
}

function labelPlay(p) {
  return ({
    strikeout: "三振",
    hit: "ヒット",
    homerun: "ホームラン",
    timely: "タイムリーヒット",
    fineplay: "ファインプレー",
    score: "得点シーン",
    pitching: "投球シーン",
    batting: "打撃シーン",
    walk: "四球",
    unknown: "不明"
  }[p] || "不明");
}

function labelSubPlay(p) {
  return ({
    swinging_strikeout: "空振り三振",
    looking_strikeout: "見逃し三振",
    left_hit: "レフト前ヒット",
    center_hit: "センター前ヒット",
    right_hit: "ライト前ヒット",
    infield_hit: "内野安打",
    flyout: "フライアウト",
    groundout: "ゴロアウト",
    diving_catch: "ダイビングキャッチ",
    double_play: "ダブルプレー",
    great_throw: "好送球",
    home_run: "ホームラン",
    unknown: "不明"
  }[p] || p || "不明");
}

function labelStyle(s) {
  return ({
    normal: "普通実況",
    hot: "熱血実況",
    pro: "プロ野球実況風",
    koshien: "高校野球実況風",
    youtube: "YouTube実況者風",
    funny: "おもしろ実況"
  }[s] || "熱血実況");
}

function labelExcitement(v) {
  return ({
    "50": "落ち着いた実況",
    "70": "やや熱い実況",
    "100": "しっかり盛り上げる実況",
    "150": "かなり熱い実況"
  }[String(v)] || "しっかり盛り上げる実況");
}

function rule(playType, subPlayType) {
  const base = {
    strikeout: "三振実況。絶対に『打った』『走れ』『打球』『ホームラン』は禁止。投手側が主役。",
    hit: "ヒット実況。三振とは言わない。ホームランとは断定しない。",
    homerun: "ホームラン実況。『いったー！』『大きい！』など。ただしユーザーが確定した場合のみ。",
    timely: "タイムリーヒット実況。得点に絡む一打として表現。",
    fineplay: "守備のファインプレー実況。『打ったー！』から始めない。",
    score: "得点シーン実況。ホームインや追加点を中心にする。",
    pitching: "投球シーン実況。打撃結果を断定しない。",
    batting: "打撃シーン実況。結果不明なら『打った』の後の結果を断定しない。",
    walk: "四球実況。打った、三振、ホームランは禁止。",
    unknown: "不明なので断定を避ける。"
  }[playType] || "断定を避ける。";

  const sub = {
    swinging_strikeout: "空振り三振として表現する。",
    looking_strikeout: "見逃し三振として表現する。",
    left_hit: "レフト方向のヒットとして表現する。",
    center_hit: "センター方向のヒットとして表現する。",
    right_hit: "ライト方向のヒットとして表現する。",
    infield_hit: "内野安打として表現する。",
    flyout: "フライアウトとして表現する。",
    groundout: "ゴロアウトとして表現する。",
    diving_catch: "ダイビングキャッチとして表現する。",
    double_play: "ダブルプレーとして表現する。",
    great_throw: "好送球として表現する。",
    home_run: "ホームランとして表現する。"
  }[subPlayType] || "";

  return base + "\n" + sub;
}


function estimateJapaneseSpeechSeconds(text) {
  const clean = String(text || "").replace(/\s+/g, "");
  // 日本語TTSは1秒あたりおよそ4〜5文字。自然音声は少し遅めに見積もる。
  return Math.max(1.0, clean.length / 4.2);
}

function cleanCommentaryText(text) {
  let t = String(text || "")
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/```/g, "")
    .replace(/^(実況|実況文|ナレーション|本文)\s*[:：]/gm, "")
    .replace(/\r/g, "")
    .trim();

  // 空行を詰める
  t = t.split(/\n+/).map(s => s.trim()).filter(Boolean).join("\n");

  // 明らかな途中切れになりやすい末尾を削る
  const brokenEndings = [
    "グラ", "グランド", "グラウ", "スタ", "ホー", "セン", "ライ", "レフ",
    "バッ", "ピッ", "キャ", "ファ", "スト", "スラ", "カーブ"
  ];

  for (const b of brokenEndings) {
    if (t.endsWith(b) || t.endsWith(b + "！") || t.endsWith(b + "!")) {
      const lines = t.split("\n");
      lines.pop();
      t = lines.join("\n").trim();
      break;
    }
  }

  return t;
}

function trimCommentarySafely(text, limit) {
  let t = cleanCommentaryText(text);
  if (!t) return "";

  if (t.length <= limit + 8) return t;

  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const kept = [];
  let count = 0;

  for (const line of lines) {
    const nextCount = count + line.length;
    if (nextCount <= limit) {
      kept.push(line);
      count = nextCount;
    }
  }

  if (kept.length > 0) {
    return cleanCommentaryText(kept.join("\n"));
  }

  // 文単位で切る
  const sentences = t.split(/(?<=[。！!？?])/).map(s => s.trim()).filter(Boolean);
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length <= limit) out += sentence;
  }

  if (out.trim()) return cleanCommentaryText(out.trim());

  // 最後の手段：短い安全文に差し替える
  return "";
}

function fallbackCommentary(playType, subPlayType, excitement) {
  const hot = Number(excitement) >= 120;

  if (subPlayType === "swinging_strikeout") {
    return hot ? "空振り三振！！\n最後は力でねじ伏せた！！" : "空振り三振。\n見事に仕留めました。";
  }
  if (subPlayType === "looking_strikeout") {
    return hot ? "見逃し三振！！\n最後は決め球が決まった！！" : "見逃し三振。\n落ち着いて決めました。";
  }
  if (playType === "strikeout") {
    return hot ? "三振を奪った！！\n大事な場面で決めた！！" : "三振を奪いました。\n見事な投球です。";
  }
  if (playType === "hit" || ["left_hit","center_hit","right_hit","infield_hit"].includes(subPlayType)) {
    return hot ? "鋭い当たり！！\nこれはヒットだ！！" : "鋭いスイング。\nヒットになりました。";
  }
  if (playType === "homerun" || subPlayType === "home_run") {
    return hot ? "大きい当たり！！\n入ったー！！" : "大きな当たり。\nホームランです。";
  }
  if (playType === "fineplay" || ["diving_catch","double_play","great_throw"].includes(subPlayType)) {
    return hot ? "これは好プレー！！\n見事にアウトを奪った！！" : "素晴らしい守備。\n見事なプレーです。";
  }
  if (subPlayType === "flyout") return hot ? "高く上がった！！\nフライアウトだ！！" : "打球は上がって、フライアウトです。";
  if (subPlayType === "groundout") return hot ? "ゴロをさばいた！！\nアウトだ！！" : "ゴロをしっかり処理しました。";
  return hot ? "勝負の瞬間！！\n見事なプレーです！！" : "緊迫の場面。\n見事なプレーです。";
}

async function refineCommentaryIfNeeded({ text, playType, subPlayType, limit, remaining, style, excitement }) {
  let t = trimCommentarySafely(text, limit);

  const badFragments = ["打球はグラ", "グラ！", "グラ。", "グラ$", "途中", "undefined"];
  const looksBroken = !t || badFragments.some(b => {
    if (b.endsWith("$")) return new RegExp(b).test(t);
    return t.includes(b);
  });

  const tooLongForVoice = estimateJapaneseSpeechSeconds(t) > remaining + 0.4;

  if (!looksBroken && !tooLongForVoice) return t;

  const fallback = fallbackCommentary(playType, subPlayType, excitement);
  if (estimateJapaneseSpeechSeconds(fallback) <= remaining + 0.8) return fallback;

  return fallback.split(/\n+/)[0];
}


async function makeCommentary({ analysis, dur, style, excitement, requestText, confirmedPlayType, confirmedSubPlayType, startTimeOverride }) {
  const playType = confirmedPlayType || analysis.bestPlayType || "unknown";
  const subPlayType = confirmedSubPlayType || analysis.subPlayType || "unknown";

  const ratio = Number(analysis.bestStartTimeRatio);
  const autoStart = Math.max(0, Math.min(dur - 1, dur * (Number.isFinite(ratio) ? ratio : 0.5)));
  const start = startTimeOverride !== undefined && startTimeOverride !== "" 
    ? Math.max(0, Math.min(dur - 1, Number(startTimeOverride)))
    : autoStart;

  const remaining = Math.max(1.5, dur - start - 0.3);
  const limit = Math.max(12, Math.floor(Math.min(remaining, 18) * 4.5));

  const prompt = `野球ショート動画用の短い実況を作成してください。

動画長さ:${dur.toFixed(1)}秒
実況開始:${start.toFixed(1)}秒
残り:${remaining.toFixed(1)}秒
最大文字数:${limit}文字

確定プレー:${labelPlay(playType)}
確定細分化:${labelSubPlay(subPlayType)}

AI推定:${labelPlay(analysis.bestPlayType)}
AI細分化:${labelSubPlay(analysis.subPlayType)}
AI信頼度:${analysis.confidence}
AI概要:${analysis.summary}
AIヒント:${analysis.commentaryHint}
注意点:${analysis.warnings || "なし"}

プレー別ルール:
${rule(playType, subPlayType)}

実況スタイル:${labelStyle(style)}
盛り上がり度:${labelExcitement(excitement)}
追加リクエスト:${requestText || "特になし"}

厳守:
- 確定プレーと確定細分化に必ず従う
- 確定プレーに反する言葉は禁止
- 前振り禁止
- タイムコード禁止
- 見出し禁止
- 実況本文のみ
- 1〜2文まで
- 必ず文を最後まで完結させる
- 途中で切れた単語は禁止
- 「打球はグラ」のような未完成文は禁止
- 短く、音声化しやすく
- 盛り上がり度150でも長くしすぎない`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "あなたは短尺野球動画に合う、誤実況を避ける実況作家です。" },
      { role: "user", content: prompt }
    ],
    temperature: Number(excitement) >= 150 ? 0.65 : 0.45,
    max_tokens: 240
  });

  let text = (r.choices?.[0]?.message?.content || "").trim();

  text = await refineCommentaryIfNeeded({
    text,
    playType,
    subPlayType,
    limit,
    remaining,
    style,
    excitement
  });

  if (!text) {
    text = fallbackCommentary(playType, subPlayType, excitement);
  }

  return { text, start, remaining, limit, playType, subPlayType };
}

function voiceName(voiceType) {
  return ({
    male: "ash",
    energetic: "ash",
    calm: "sage",
    female: "coral"
  }[voiceType] || "ash");
}

function humanVoiceInstructions(voiceType) {
  const base = [
    "あなたは日本の野球中継の実況アナウンサーです。",
    "AI音声っぽくならないように、自然な抑揚と間を入れて読んでください。",
    "短尺動画向けに、聞き取りやすく、感情を込めてください。",
    "叫びすぎず、でも勝負どころでは熱を出してください。",
    "句読点では自然に少し間を置いてください。",
    "早口になりすぎないでください。"
  ];

  if (voiceType === "energetic") {
    base.push("テンションは高め。スポーツ実況らしく、決定的な場面は力強く読んでください。");
  } else if (voiceType === "calm") {
    base.push("落ち着いたプロ実況風。熱さはあるが、上品で聞き取りやすく読んでください。");
  } else if (voiceType === "female") {
    base.push("明るく自然な実況者風。感情豊かに、聞き取りやすく読んでください。");
  } else {
    base.push("男性スポーツアナウンサー風。自然で力強く、野球実況らしく読んでください。");
  }

  return base.join("\n");
}

async function voice(text, voiceType, out) {
  const selectedVoice = voiceName(voiceType);

  try {
    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: selectedVoice,
      input: text,
      instructions: humanVoiceInstructions(voiceType),
      format: "mp3"
    });

    fs.writeFileSync(out, Buffer.from(await mp3.arrayBuffer()));
  } catch (e) {
    console.warn("gpt-4o-mini-tts failed. fallback to tts-1:", e.message);

    const fallbackVoice = ({
      male: "onyx",
      energetic: "echo",
      calm: "alloy",
      female: "nova"
    }[voiceType] || "onyx");

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: fallbackVoice,
      input: text,
      format: "mp3"
    });

    fs.writeFileSync(out, Buffer.from(await mp3.arrayBuffer()));
  }
}

async function adjust(input, output, target) {
  let d = null;
  try { d = await duration(input); } catch {}
  if (!d || d <= target) {
    fs.copyFileSync(input, output);
    return;
  }
  const tempo = Math.min(1.8, Math.max(1.05, d / target));
  await execFileAsync("ffmpeg", ["-y", "-i", input, "-filter:a", `atempo=${tempo.toFixed(3)}`, "-vn", output]);
}

async function hasAudioStream(video) {
  try {
    const { stdout } = await execFileAsync(ffprobeStatic.path, [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      video
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function merge(video, audio, out, start) {
  const delay = Math.max(0, Math.floor(start * 1000));
  const originalHasAudio = await hasAudioStream(video);

  if (originalHasAudio) {
    // 元動画音声50% + AI実況音声100%でミックス
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", video,
      "-i", audio,
      "-filter_complex",
      `[0:a]volume=0.5[a0];[1:a]adelay=${delay}|${delay},volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      out
    ]);
  } else {
    // 元動画に音声がない場合は、従来通りAI実況だけ合成
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", video,
      "-i", audio,
      "-filter_complex",
      `[1:a]adelay=${delay}|${delay},volume=1.0[aout]`,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      out
    ]);
  }
}

function qualityReport(analysis) {
  const recognition = Number(analysis.confidence || 0);
  const timing = Number(analysis.timingConfidence || Math.max(55, recognition - 10));
  const fit = Number(analysis.commentaryFitScore || Math.max(55, recognition - 5));
  const avg = Math.round((recognition + timing + fit) / 3);
  let grade = analysis.overallGrade || "C";
  if (!analysis.overallGrade) {
    grade = avg >= 90 ? "S" : avg >= 80 ? "A" : avg >= 65 ? "B" : avg >= 50 ? "C" : "D";
  }
  return { recognition, timing, fit, avg, grade };
}

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "動画を選択してください。" });

    const video = req.file.path;
    const dur = await duration(video);

    if (!Number.isFinite(dur) || dur <= 0) return res.status(400).json({ error: "動画の長さを取得できませんでした。" });
    if (dur > 300) return res.status(400).json({ error: "β版では5分以内の動画にしてください。" });

    const id = `${Date.now()}-${Math.round(Math.random()*1e9)}`;
    const framePaths = await extractFrames(video, dur, id);
    const analysis = await analyze(framePaths);
    const quality = qualityReport(analysis);

    videoStore.set(id, { video, dur, analysis });

    const needsConfirm = analysis.bestPlayType === "unknown" || Number(analysis.confidence || 0) < 75;

    res.json({ videoId:id, analysis, quality, duration:dur, needsConfirm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "解析中にエラーが発生しました。" });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const { videoId, style, excitement, voiceType, requestText, confirmedPlayType, confirmedSubPlayType, startTimeOverride } = req.body;
    const item = videoStore.get(videoId);
    if (!item) return res.status(400).json({ error: "動画情報が見つかりません。もう一度アップロードしてください。" });

    const c = await makeCommentary({
      analysis:item.analysis,
      dur:item.dur,
      style,
      excitement,
      requestText,
      confirmedPlayType,
      confirmedSubPlayType,
      startTimeOverride
    });

    const id = `${Date.now()}-${Math.round(Math.random()*1e9)}`;
    const raw = path.join(outputsDir, `${id}.mp3`);
    const adj = path.join(outputsDir, `${id}-adjusted.mp3`);
    const out = path.join(outputsDir, `${id}.mp4`);

    await voice(c.text, voiceType, raw);
    await adjust(raw, adj, Math.max(1, c.remaining));
    await merge(item.video, adj, out, c.start);

    res.json({
      analysis:item.analysis,
      quality: qualityReport(item.analysis),
      confirmedPlayType:c.playType,
      confirmedSubPlayType:c.subPlayType,
      commentary:c.text,
      duration:item.dur,
      startTime:c.start,
      remaining:c.remaining,
      charLimit:c.limit,
      audioUrl:`/outputs/${id}-adjusted.mp3`,
      videoUrl:`/outputs/${id}.mp4`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "生成中にエラーが発生しました。" });
  }
});

app.listen(port, () => console.log(`俺の実況 V12.3 実況文品質改善版 server running on http://localhost:${port}`));
