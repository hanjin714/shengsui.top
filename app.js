const defaultScript = `真正好的工具，不应该打断表达。

它应该安静地站在镜头旁边，理解你正在说什么，也知道你接下来准备说什么。

这就是声随。一个会听你说话的智能提词器。

导入你的画面，放入口播稿，点击开始。文字不再按照固定速度机械滚动，而是跟随你的声音自然前进。

你可以停顿，可以临场发挥，也可以回到上一句。它不会催促你，只会重新找到你的位置。

现在，看着镜头。按照自己的节奏，把想说的话，好好说完。`;

const state = {
  script: localStorage.getItem("shengsui-script") || defaultScript,
  tokens: [],
  normalizedChars: [],
  currentIndex: 0,
  selectedStartIndex: null,
  lastProgressIndex: 0,
  lastProgressAt: 0,
  fontSize: 46,
  listening: false,
  followVoice: true,
  recognition: null,
  recognitionAvailable: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  recognitionHasResult: false,
  pendingJumpIndex: null,
  pendingJumpHits: 0,
  lastMatchedIndex: 0,
  audioStream: null,
  audioContext: null,
  audioSource: null,
  analyser: null,
  audioFrame: null,
  speechStartedAt: 0,
  lastVoiceAt: 0,
  lastAdvanceAt: 0,
  advanceCredit: 0,
  noiseFloor: 0.001,
  voiceLevel: 0,
  sensitivity: Number(localStorage.getItem("shengsui-sensitivity") || 72),
  audioStartedAt: 0,
  voiceFrames: 0,
  silentFrames: 0,
  wasSpeaking: false,
  silenceStartedAt: 0,
  resumedAt: 0,
  displayOrientation: localStorage.getItem("shengsui-orientation") || "auto",
};

const $ = (selector) => document.querySelector(selector);
const scriptContent = $("#scriptContent");
const teleprompter = $("#teleprompter");
const speechConsole = $(".speech-console");
const recordButton = $("#recordButton");

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokenize(text) {
  const pieces = text.match(/[\p{Script=Han}]|[a-zA-Z0-9]+(?:['’-][a-zA-Z0-9]+)*|[^\p{L}\p{N}\s]|\s+/gu) || [];
  return pieces.map((raw) => ({
    raw,
    normalized: normalize(raw),
    isSpace: /^\s+$/.test(raw),
    isPunctuation: !/[\p{L}\p{N}]/u.test(raw) && !/^\s+$/.test(raw),
  }));
}

function renderScript() {
  state.tokens = tokenize(state.script);
  state.normalizedChars = [];
  let charOffset = 0;
  scriptContent.innerHTML = "";

  state.tokens.forEach((token, index) => {
    if (token.isSpace) {
      scriptContent.append(document.createTextNode(token.raw));
      return;
    }
    const span = document.createElement("span");
    span.className = `script-token${token.isPunctuation ? " punctuation" : ""}`;
    span.textContent = token.raw;
    span.dataset.index = index;
    span.dataset.charStart = charOffset;
    charOffset += token.normalized.length;
    span.dataset.charEnd = charOffset;
    scriptContent.append(span);
    for (const char of token.normalized) state.normalizedChars.push({ char, tokenIndex: index });
  });
  setProgress(0, false);
}

function setProgress(tokenIndex, smooth = true) {
  const visibleTokens = [...scriptContent.querySelectorAll(".script-token")];
  if (!visibleTokens.length) return;
  const previousIndex = state.currentIndex;
  const now = performance.now();
  state.currentIndex = Math.max(0, Math.min(tokenIndex, state.tokens.length - 1));

  visibleTokens.forEach((el) => {
    const index = Number(el.dataset.index);
    el.classList.toggle("spoken", index < state.currentIndex);
    el.classList.toggle("current", index === state.currentIndex);
  });

  const current = scriptContent.querySelector(`[data-index="${state.currentIndex}"]`) ||
    visibleTokens.find((el) => Number(el.dataset.index) >= state.currentIndex) ||
    visibleTokens.at(-1);
  if (current) {
    const readingLine = scriptContent.clientHeight * 0.30;
    const desiredTop = Math.max(0, current.offsetTop - readingLine);
    const scrollDistance = Math.abs(scriptContent.scrollTop - desiredTop);
    const indexJump = Math.abs(state.currentIndex - previousIndex);
    const updateInterval = now - state.lastProgressAt;
    // 语速快、识别结果跳词或字幕已经落后时立即追上；慢速口播才保留柔和动画。
    const needsCatchUp = indexJump > 2 || updateInterval < 240 || scrollDistance > scriptContent.clientHeight * 0.16;
    scriptContent.scrollTo({
      top: desiredTop,
      behavior: smooth && !needsCatchUp ? "smooth" : "auto",
    });
  }

  state.lastProgressIndex = state.currentIndex;
  state.lastProgressAt = now;
  const progress = Math.round((state.currentIndex / Math.max(1, state.tokens.length - 1)) * 100);
  $("#progressText").textContent = `${progress}%`;
}

function nextReadableToken(fromIndex, direction = 1) {
  let index = fromIndex + direction;
  while (index >= 0 && index < state.tokens.length && state.tokens[index]?.isSpace) index += direction;
  return Math.max(0, Math.min(index, state.tokens.length - 1));
}

function advanceByVoice(amount = 1) {
  let next = state.currentIndex;
  for (let i = 0; i < amount; i++) next = nextReadableToken(next, 1);
  setProgress(next);
}

function isSentenceBoundary(token) {
  return Boolean(token && /[。！？!?；;：:\n]/.test(token.raw));
}

function sentenceStartIndex(fromIndex = state.currentIndex) {
  for (let index = Math.min(fromIndex - 1, state.tokens.length - 1); index >= 0; index--) {
    if (isSentenceBoundary(state.tokens[index])) return nextReadableToken(index, 1);
  }
  return 0;
}

function sentenceEndIndex(fromIndex) {
  for (let index = fromIndex; index < state.tokens.length; index++) {
    if (isSentenceBoundary(state.tokens[index])) return index;
  }
  return state.tokens.length - 1;
}

function clearSentenceSelection() {
  scriptContent.querySelectorAll(".selected-sentence, .selected-start").forEach((element) => {
    element.classList.remove("selected-sentence", "selected-start");
  });
  state.selectedStartIndex = null;
  $("#startHereButton").classList.add("hidden");
}

function selectSentenceAt(tokenIndex) {
  const start = sentenceStartIndex(tokenIndex + 1);
  const end = sentenceEndIndex(start);
  clearSentenceSelection();
  state.selectedStartIndex = start;

  scriptContent.querySelectorAll(".script-token").forEach((element) => {
    const index = Number(element.dataset.index);
    if (index >= start && index <= end) element.classList.add("selected-sentence");
    if (index === start) element.classList.add("selected-start");
  });

  const anchor = scriptContent.querySelector(`[data-index="${start}"]`);
  const button = $("#startHereButton");
  if (anchor) {
    const containerRect = teleprompter.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const top = Math.max(62, Math.min(
      teleprompter.clientHeight - 62,
      anchorRect.top - containerRect.top + anchorRect.height / 2,
    ));
    button.style.top = `${top}px`;
  }
  button.classList.remove("hidden");
}

function startFromSelection() {
  if (state.selectedStartIndex == null) return;
  const target = state.selectedStartIndex;
  clearSentenceSelection();
  setProgress(target);
  state.advanceCredit = 0;
  state.speechStartedAt = 0;
  state.recognitionHasResult = false;
  state.pendingJumpIndex = null;
  state.pendingJumpHits = 0;
  $("#liveTranscript").textContent = "已设定新的起点，可以从这里开始口播";
  $("#sessionStatus").textContent = "已切换起点";
}

function isAtSentenceEnd(fromIndex = state.currentIndex) {
  for (let offset = -1; offset <= 3; offset++) {
    const token = state.tokens[fromIndex + offset];
    if (isSentenceBoundary(token)) return true;
  }
  return false;
}

function repeatCurrentSentence(message = true) {
  const target = sentenceStartIndex();
  state.pendingJumpIndex = null;
  state.pendingJumpHits = 0;
  setProgress(target);
  state.advanceCredit = 0;
  if (message) $("#liveTranscript").textContent = "已回到本句开头，请重新说";
}

function findTranscriptPosition(transcript) {
  const heard = normalize(transcript);
  if (!heard) return null;
  const scriptString = state.normalizedChars.map((item) => item.char).join("");
  const currentChar = Number(scriptContent.querySelector(`[data-index="${state.currentIndex}"]`)?.dataset.charStart || 0);

  let best = null;
  // 搜索整篇原稿，允许用户跳到任意上文或下文。长匹配优先，同文重复时选择离当前位置最近者。
  for (let length = Math.min(heard.length, 36); length >= Math.min(4, heard.length); length--) {
    const fragment = heard.slice(-length);
    let scriptIndex = scriptString.indexOf(fragment);
    while (scriptIndex >= 0) {
      const candidateEnd = scriptIndex + fragment.length;
      const charDistance = Math.abs(candidateEnd - currentChar);
      const score = length * 1000 - charDistance;
      if (!best || score > best.score) {
        best = { candidateEnd, length, charDistance, score };
      }
      scriptIndex = scriptString.indexOf(fragment, scriptIndex + 1);
    }
    if (best && length >= 10) break;
  }

  if (!best) return null;
  const index = state.normalizedChars[Math.min(best.candidateEnd, state.normalizedChars.length - 1)]?.tokenIndex;
  return index == null ? null : { index, matchLength: best.length, charDistance: best.charDistance };
}

function applyTranscriptPosition(match) {
  if (!match) return;
  const tokenDistance = match.index - state.currentIndex;
  const largeJump = Math.abs(tokenDistance) > 55;

  if (largeJump) {
    const sameCandidate = state.pendingJumpIndex != null && Math.abs(state.pendingJumpIndex - match.index) < 12;
    state.pendingJumpIndex = match.index;
    state.pendingJumpHits = sameCandidate ? state.pendingJumpHits + 1 : 1;
    // 大跨度跳读至少连续命中两次，且需要更长文本，避免原稿中的重复短语造成误跳。
    if (state.pendingJumpHits < 2 || match.matchLength < 6) {
      $("#liveTranscript").textContent = tokenDistance < 0
        ? "检测到你可能回到了上文，正在确认位置…"
        : "检测到你可能跳到了下文，正在确认位置…";
      return;
    }
  } else {
    state.pendingJumpIndex = null;
    state.pendingJumpHits = 0;
  }

  const direction = tokenDistance < -2 ? "backward" : tokenDistance > 2 ? "forward" : "continue";
  setProgress(match.index, !largeJump);
  state.lastMatchedIndex = match.index;
  if (largeJump) {
    $("#liveTranscript").textContent = direction === "backward"
      ? "已重新定位到上文，继续读即可"
      : "已跳过中间内容，定位到下文";
    state.pendingJumpIndex = null;
    state.pendingJumpHits = 0;
  }
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    state.recognitionHasResult = true;
    let combined = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      combined += event.results[i][0].transcript;
    }
    $("#liveTranscript").textContent = combined || "正在聆听…";
    if (state.followVoice) applyTranscriptPosition(findTranscriptPosition(combined));
  };
  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "麦克风权限未开启，请在浏览器地址栏允许访问。",
      "no-speech": "暂时没有听到声音，我还在等你开口。",
      network: "语音服务暂时无法连接，请检查网络。",
    };
    state.recognitionAvailable = false;
    $("#engineLabel").textContent = "本地声能跟随";
    $("#liveTranscript").textContent = `${messages[event.error] || "逐字识别不可用"}，已切换本地跟随。`;
  };
  recognition.onend = () => {
    if (state.listening && state.recognitionAvailable) {
      try { recognition.start(); } catch (_) { /* Browser restart race. */ }
    }
  };
  return recognition;
}

async function setupAudioFollower() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境无法访问麦克风");
  state.audioStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContext();
  await state.audioContext.resume();
  state.audioSource = state.audioContext.createMediaStreamSource(state.audioStream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  state.analyser.smoothingTimeConstant = 0.35;
  state.audioSource.connect(state.analyser);

  const samples = new Float32Array(state.analyser.fftSize);
  state.lastAdvanceAt = performance.now();
  state.audioStartedAt = performance.now();
  state.speechStartedAt = 0;
  state.advanceCredit = 0;
  state.voiceFrames = 0;
  state.silentFrames = 0;
  state.wasSpeaking = false;
  state.silenceStartedAt = performance.now();
  state.resumedAt = 0;

  const trackVoice = (now) => {
    if (!state.listening || !state.analyser) {
      state.audioFrame = null;
      return;
    }
    state.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const volume = Math.sqrt(sum / samples.length);

    // 启动后的前 700ms 只学习环境底噪。之后仅在安静帧缓慢更新，避免把人声学成噪声。
    const calibrating = now - state.audioStartedAt < 700;
    if (calibrating || volume < state.noiseFloor * 1.35) {
      const learningRate = calibrating ? 0.12 : 0.008;
      state.noiseFloor = Math.max(0.0001, state.noiseFloor * (1 - learningRate) + volume * learningRate);
    }
    const sensitivityFactor = 2.45 - (state.sensitivity / 100) * 1.35;
    const threshold = Math.max(0.0007, state.noiseFloor * sensitivityFactor);
    const rawVoice = !calibrating && (volume > threshold || peak > threshold * 3.2);

    if (rawVoice) {
      state.voiceFrames += 1;
      state.silentFrames = 0;
    } else {
      state.silentFrames += 1;
      if (state.silentFrames > 2) state.voiceFrames = 0;
    }
    // 连续两帧才开启，避免键盘敲击；开启后保留短暂尾音。
    const voiceActive = state.voiceFrames >= 2;
    state.voiceLevel = Math.min(1, volume / Math.max(threshold * 3.5, 0.003));
    document.documentElement.style.setProperty("--voice-level", state.voiceLevel.toFixed(3));
    document.documentElement.style.setProperty("--voice-height", `${5 + state.voiceLevel * 17}px`);
    $("#audioDebug").textContent = calibrating
      ? "正在校准环境…"
      : `音量 ${volume.toFixed(4)} / 门槛 ${threshold.toFixed(4)}`;
    if (voiceActive) {
      state.lastVoiceAt = now;
      if (!state.speechStartedAt) state.speechStartedAt = now;
    }
    const speaking = now - state.lastVoiceAt < 420;
    speechConsole.classList.toggle("voice-active", speaking);

    // 浏览器有逐字识别时以文本匹配为准，否则使用本地口播节奏跟随。
    const shouldUseCadence = !state.recognitionAvailable && !state.recognitionHasResult;
    if (speaking && !state.wasSpeaking) {
      const pauseDuration = now - state.silenceStartedAt;
      state.resumedAt = now;
      if (
        shouldUseCadence &&
        state.speechStartedAt &&
        state.speechStartedAt < state.silenceStartedAt &&
        pauseDuration > 780 &&
        pauseDuration < 7000 &&
        !isAtSentenceEnd()
      ) {
        repeatCurrentSentence(false);
        $("#liveTranscript").textContent = "检测到句中重说，已自动回到本句开头";
      }
    } else if (!speaking && state.wasSpeaking) {
      state.silenceStartedAt = now;
    }
    state.wasSpeaking = speaking;

    if (speaking && shouldUseCadence && state.followVoice) {
      const elapsed = Math.min(100, now - state.lastAdvanceAt);
      if (now - state.resumedAt > 260) state.advanceCredit += elapsed * 0.0052;
      if (state.advanceCredit >= 1) {
        const steps = Math.min(2, Math.floor(state.advanceCredit));
        state.advanceCredit -= steps;
        advanceByVoice(steps);
      }
      $("#liveTranscript").textContent = "检测到口播，正在按你的声音跟随…";
    } else if (!speaking && shouldUseCadence && now - state.lastVoiceAt > 700) {
      state.advanceCredit = 0;
      if (state.speechStartedAt) $("#liveTranscript").textContent = "已停在这里，等你继续说";
    }
    state.lastAdvanceAt = now;
    state.audioFrame = requestAnimationFrame(trackVoice);
  };
  state.audioFrame = requestAnimationFrame(trackVoice);
}

function teardownAudioFollower() {
  if (state.audioFrame) cancelAnimationFrame(state.audioFrame);
  state.audioFrame = null;
  state.audioStream?.getTracks().forEach((track) => track.stop());
  state.audioStream = null;
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.audioSource = null;
  state.analyser = null;
  speechConsole.classList.remove("voice-active");
}

async function startListening() {
  if (state.listening) return;
  // 必须在创建音频分析循环前置为 true，否则 requestAnimationFrame 第一帧会直接退出。
  state.listening = true;
  $("#liveTranscript").textContent = "正在连接麦克风…";
  try {
    await setupAudioFollower();
  } catch (error) {
    state.listening = false;
    teardownAudioFollower();
    $("#liveTranscript").textContent = `${error.message || "麦克风启动失败"}，请检查浏览器权限。`;
    $("#sessionStatus").textContent = "麦克风不可用";
    return;
  }
  if (!state.recognition) {
    state.recognition = setupRecognition();
  }
  state.recognitionHasResult = false;
  if (state.recognition) {
    try { state.recognition.start(); } catch (_) { /* Already started. */ }
  }
  recordButton.classList.add("listening");
  speechConsole.classList.add("listening");
  $(".session-pill").classList.add("recording");
  $("#sessionStatus").textContent = "正在语音跟随";
  $("#engineLabel").textContent = state.recognitionAvailable ? "逐字识别 + 声能跟随" : "本地声能跟随";
  $("#liveTranscript").textContent = state.recognitionAvailable
    ? "正在聆听，请开始口播…"
    : "本地跟随已启动：开口前进，停顿即停";
}

function stopListening() {
  state.listening = false;
  try { state.recognition?.stop(); } catch (_) { /* Already stopped. */ }
  teardownAudioFollower();
  recordButton.classList.remove("listening");
  speechConsole.classList.remove("listening");
  $(".session-pill").classList.remove("recording");
  $("#sessionStatus").textContent = "已暂停";
  $("#liveTranscript").textContent = "语音跟随已暂停";
  document.documentElement.style.setProperty("--voice-level", "0");
  document.documentElement.style.setProperty("--voice-height", "5px");
}

function toggleListening() {
  state.listening ? stopListening() : startListening();
}

function setFontSize(size) {
  state.fontSize = Math.max(26, Math.min(78, size));
  teleprompter.style.setProperty("--script-size", `${state.fontSize}px`);
  $("#fontSizeLabel").textContent = state.fontSize;
  $("#fullscreenFontValue").textContent = state.fontSize;
}

function setMirror(enabled) {
  scriptContent.classList.toggle("mirrored", enabled);
  $("#mirrorButton").classList.toggle("active", enabled);
  $("#fullscreenMirrorButton").classList.toggle("active", enabled);
}

const orientationOptions = {
  auto: { label: "自动方向", icon: "◫", lock: null },
  portrait: { label: "竖屏显示", icon: "▯", lock: "portrait-primary" },
  landscape: { label: "横屏显示", icon: "▭", lock: "landscape-primary" },
};

function showOrientationNotice(message) {
  document.querySelector(".orientation-notice")?.remove();
  const notice = document.createElement("div");
  notice.className = "orientation-notice";
  notice.textContent = message;
  document.body.append(notice);
  setTimeout(() => notice.remove(), 2600);
}

async function applyOrientationLock() {
  const option = orientationOptions[state.displayOrientation];
  if (!document.fullscreenElement || !screen.orientation) return;
  try {
    if (option.lock && screen.orientation.lock) {
      await screen.orientation.lock(option.lock);
    } else if (screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  } catch (_) {
    showOrientationNotice(option.lock === "landscape-primary"
      ? "当前浏览器无法锁定横屏，请旋转设备"
      : "当前浏览器无法锁定竖屏，请旋转设备");
  }
}

function setDisplayOrientation(value, announce = true) {
  state.displayOrientation = orientationOptions[value] ? value : "auto";
  localStorage.setItem("shengsui-orientation", state.displayOrientation);
  document.body.dataset.displayOrientation = state.displayOrientation;
  const option = orientationOptions[state.displayOrientation];
  ["#orientationButton", "#fullscreenOrientationButton"].forEach((selector) => {
    const button = $(selector);
    if (button) button.innerHTML = `<span>${option.icon}</span> ${option.label}`;
  });
  if (announce) {
    showOrientationNotice(state.displayOrientation === "auto"
      ? "已跟随设备自动切换方向"
      : `已选择${option.label}，全屏后会尝试锁定方向`);
  }
  applyOrientationLock();
}

function cycleDisplayOrientation() {
  const order = ["auto", "portrait", "landscape"];
  setDisplayOrientation(order[(order.indexOf(state.displayOrientation) + 1) % order.length]);
}

function updateFullscreenControls() {
  $("#fullscreenSpeechButton").classList.toggle("active", state.listening);
  $("#fullscreenSpeechButton").innerHTML = state.listening ? "<span>Ⅱ</span> 暂停口播" : "<span>◉</span> 开始口播";
}

async function toggleTeleprompterFullscreen() {
  if (document.fullscreenElement === teleprompter) await document.exitFullscreen();
  else {
    await teleprompter.requestFullscreen();
    await applyOrientationLock();
  }
}

function loadScriptFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.script = String(reader.result).replace(/^---[\s\S]*?---/, "").trim();
    localStorage.setItem("shengsui-script", state.script);
    renderScript();
    $("#sessionStatus").textContent = `已载入 ${file.name}`;
  };
  reader.readAsText(file);
}

recordButton.addEventListener("click", toggleListening);
$("#scriptInput").addEventListener("change", (event) => loadScriptFile(event.target.files[0]));
$("#fontDown").addEventListener("click", () => {
  setFontSize(state.fontSize - 4);
});
$("#fontUp").addEventListener("click", () => {
  setFontSize(state.fontSize + 4);
});
$("#mirrorButton").addEventListener("click", (event) => {
  setMirror(!scriptContent.classList.contains("mirrored"));
});
$("#followButton").addEventListener("click", (event) => {
  state.followVoice = !state.followVoice;
  event.currentTarget.classList.toggle("active", state.followVoice);
});
$("#repeatButton").addEventListener("click", () => repeatCurrentSentence());
$("#orientationButton").addEventListener("click", cycleDisplayOrientation);
$("#fullscreenButton").addEventListener("click", toggleTeleprompterFullscreen);
$("#fullscreenExitButton").addEventListener("click", () => document.exitFullscreen());
$("#fullscreenSpeechButton").addEventListener("click", () => {
  toggleListening();
  setTimeout(updateFullscreenControls, 50);
});
$("#fullscreenMirrorButton").addEventListener("click", () => {
  setMirror(!scriptContent.classList.contains("mirrored"));
});
$("#fullscreenOrientationButton").addEventListener("click", cycleDisplayOrientation);
$("#fullscreenFontDown").addEventListener("click", () => setFontSize(state.fontSize - 4));
$("#fullscreenFontUp").addEventListener("click", () => setFontSize(state.fontSize + 4));
$("#fullscreenRepeatButton").addEventListener("click", () => repeatCurrentSentence());
document.addEventListener("fullscreenchange", () => {
  $("#fullscreenButton").classList.toggle("active", document.fullscreenElement === teleprompter);
  updateFullscreenControls();
  if (document.fullscreenElement) applyOrientationLock();
  else if (screen.orientation?.unlock) screen.orientation.unlock();
});
scriptContent.addEventListener("click", (event) => {
  const token = event.target.closest(".script-token");
  if (!token) return;
  selectSentenceAt(Number(token.dataset.index));
});
$("#startHereButton").addEventListener("click", startFromSelection);
scriptContent.addEventListener("scroll", () => {
  if (state.selectedStartIndex == null) return;
  const anchor = scriptContent.querySelector(`[data-index="${state.selectedStartIndex}"]`);
  if (!anchor) return;
  const containerRect = teleprompter.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const visible = anchorRect.bottom > containerRect.top + 20 && anchorRect.top < containerRect.bottom - 20;
  $("#startHereButton").classList.toggle("hidden", !visible);
  if (visible) {
    const top = Math.max(62, Math.min(
      teleprompter.clientHeight - 62,
      anchorRect.top - containerRect.top + anchorRect.height / 2,
    ));
    $("#startHereButton").style.top = `${top}px`;
  }
});
$("#sensitivityInput").value = state.sensitivity;
$("#sensitivityValue").textContent = state.sensitivity;
$("#sensitivityInput").addEventListener("input", (event) => {
  state.sensitivity = Number(event.target.value);
  $("#sensitivityValue").textContent = state.sensitivity;
  localStorage.setItem("shengsui-sensitivity", state.sensitivity);
});
$("#editButton").addEventListener("click", () => {
  $("#scriptEditor").value = state.script;
  $("#editorDialog").showModal();
});
$("#saveScript").addEventListener("click", () => {
  state.script = $("#scriptEditor").value.trim() || defaultScript;
  localStorage.setItem("shengsui-script", state.script);
  renderScript();
});
$("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());

document.addEventListener("keydown", (event) => {
  if (event.target.matches("textarea, input") || document.querySelector("dialog[open]")) return;
  if (event.code === "Space") {
    event.preventDefault();
    toggleListening();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    setProgress(state.currentIndex + 4);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setProgress(state.currentIndex - 4);
  } else if (event.key.toLowerCase() === "r") {
    repeatCurrentSentence();
  } else if (event.key === "?") {
    $("#helpDialog").showModal();
  }
});

renderScript();
setDisplayOrientation(state.displayOrientation, false);
$("#engineLabel").textContent = state.recognitionAvailable ? "逐字识别可用" : "本地声能模式";
