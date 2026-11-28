/* Atlantic Meridian one-take interview page.
 * No question text ships with this page: each question comes from the server
 * only when it is revealed, and the server enforces one attempt per token. */
(function () {
  'use strict';
  var CFG = window.AM_CONFIG || {};
  var API = CFG.apiUrl;
  var $ = function (s) { return document.querySelector(s); };
  var S = {
    token: readToken(), sid: null, info: null, stream: null, recorder: null, chunks: [], mime: '',
    cid: 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10), // this page load only (never stored)
    shownAt: 0, roomSecs: 0,
    index: -1, total: 0, answer: 150, overtime: 30, phase: 'idle', phaseEnd: 0, phaseLen: 0, tick: null,
    recStart: 0, camOk: false, picOk: false, micOk: false, audioCtx: null, pendingBlob: null, doneArmed: 0,
  };

  // ------------------------------------------------------------ helpers --
  function readToken() {
    var h = new URLSearchParams(location.hash.replace(/^#/, ''));
    var q = new URLSearchParams(location.search);
    return (h.get('t') || q.get('t') || '').trim();
  }
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (el) { el.removeAttribute('data-active'); });
    $('#' + id).setAttribute('data-active', '');
    window.scrollTo(0, 0);
  }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }
  function fmtSecs(s) {
    s = Math.max(0, Math.ceil(s)); var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function human(s) {
    if (s < 60) return s + ' seconds';
    var m = s / 60; return (m % 1 === 0 ? m : m.toFixed(1)) + (m === 1 ? ' minute' : ' minutes');
  }
  function interviewing() { return ['room', 'question', 'answer', 'overtime', 'saving'].indexOf(S.phase) !== -1; }
  var UA = navigator.userAgent || '';
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var IN_APP = /FBAN|FBAV|Instagram|LinkedInApp|GSA\/|Line\/|; wv\)|Indeed/i.test(UA);
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One request. Times out instead of hanging forever (a hung request used to leave the page stuck).
  function api(action, payload, timeoutMs) {
    var body = Object.assign({ action: action, token: S.token, sid: S.sid, cid: S.cid }, payload || {});
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    return fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), redirect: 'follow', cache: 'no-store', credentials: 'omit',
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      clearTimeout(timer);
      try { return JSON.parse(t); } catch (e) { throw new Error('bad_json'); } // e.g. a Google error page
    }, function (e) { clearTimeout(timer); throw e; });
  }
  // Same request, retried on network trouble or "busy". Only used for calls that are safe to repeat
  // (hello, begin with this page's cid, reveal with "want", room, finish).
  function call(action, payload, tries) {
    tries = tries || 4;
    return (function attempt(n) {
      return api(action, payload).then(function (r) {
        if (r && !r.ok && r.code === 'busy' && n + 1 < tries) return wait(1500 * (n + 1)).then(function () { return attempt(n + 1); });
        return r;
      }, function (e) {
        if (n + 1 >= tries) throw e;
        if (S.sid) beacon('net_retry', action + ':' + (e && e.message || 'error'));
        return wait(Math.min(8000, 1200 * Math.pow(2, n))).then(function () { return attempt(n + 1); });
      });
    })(0);
  }
  function beacon(type, detail) {
    if (!S.sid) return;
    var body = JSON.stringify({ action: 'event', token: S.token, sid: S.sid, type: type, index: S.index, detail: detail || '' });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([body], { type: 'text/plain;charset=utf-8' }))) return;
    } catch (e) { /* fall through */ }
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, keepalive: true }).catch(function () {});
  }

  var ERR = {
    invalid: ['Unavailable', 'This interview link isn’t valid', 'Please use the exact link from your invitation email.'],
    expired: ['Expired', 'This interview link has expired', 'The deadline in your invitation has passed. If you think this is a mistake, reply to your invitation email.'],
    complete: ['Complete', 'You’ve already completed this interview', 'Each interview link can be used once. Your answers were submitted, and Derick Osei will follow up by email.'],
    locked: ['Closed', 'This interview can’t be reopened', 'This link was already used to start the interview, and the interview can only be taken once. If something went wrong, reply to your invitation email and tell us what happened.'],
    session_replaced: ['Closed', 'The interview was opened somewhere else', 'This window has stopped because the same interview link was opened in another tab, window, or device. The question that was on screen here is closed. Continue only in the newest window.'],
    unsupported: ['Not supported', 'This browser can’t record your interview', 'Open the link in Chrome, Edge, or Safari (not inside the Mail, Gmail, LinkedIn, or Indeed app) on a device with a camera. You can copy the link below and paste it into your browser.'],
    network: ['Connection problem', 'We couldn’t reach the interview service', 'We tried several times. Check your internet connection (switching from Wi-Fi to mobile data, or the other way, often helps) and reload this page. If you had already started, the question that was on screen is closed and cannot be retaken.'],
    busy: ['Busy', 'The interview service is busy', 'Please wait a minute and reload this page. Nothing you recorded so far is lost.'],
    server_error: ['Problem', 'Something went wrong on our side', 'Please reload this page once. If it happens again, reply to your invitation email with the error code below and we will send you a fresh link.'],
  };
  function fatal(code) {
    var known = !!ERR[code];
    var e = ERR[code] || ERR.server_error;
    $('#err-badge').textContent = e[0];
    $('#err-badge').className = 'badge ' + (code === 'complete' ? 'badge-ok' : 'badge-warn');
    $('#err-title').textContent = e[1];
    $('#err-body').textContent = e[2];
    var codeEl = $('#err-code');
    if (codeEl) {
      var withCode = code && code !== 'complete' && code !== 'invalid';
      codeEl.hidden = !withCode;
      codeEl.textContent = withCode ? 'Error code: ' + code + (known ? '' : ' (unrecognized)') + (S.index >= 0 ? ' · question ' + (S.index + 1) : '') : '';
    }
    var copy = $('#err-copy');
    if (copy) copy.hidden = code !== 'unsupported';
    if (S.sid && code !== 'complete') beacon('client_error', 'fatal:' + code);
    S.phase = 'stopped';
    stopEverything();
    show('s-error');
  }
  function stopEverything() {
    clearInterval(S.tick);
    try { sttStop(); } catch (e) {}
    try { if (S.seg && S.seg.rec.state !== 'inactive') { S.seg.rec.onstop = null; S.seg.rec.stop(); } } catch (e) {}
    if (S.stream) S.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    if (S.audioCtx) { try { S.audioCtx.close(); } catch (e) {} }
  }

  // --------------------------------------------------------------- init --
  function init() {
    document.querySelectorAll('.contact').forEach(function (a) {
      a.textContent = CFG.contactEmail || ''; a.href = 'mailto:' + (CFG.contactEmail || '');
    });
    if (!API) return fatal('server_error');
    if (!S.token) return fatal('invalid');
    // Keep the token out of the address bar history after load.
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return fatal('unsupported');
    call('hello', { ua: UA.slice(0, 160) }, 4).then(function (r) {
      if (!r.ok) return fatal(r.code);
      if (r.state !== 'ready' && r.state !== 'resume') return fatal(r.state);
      S.info = r; S.total = r.total; S.answer = r.answer; S.overtime = r.overtime || 30;
      S.roomSecs = Number(r.room) || 0; // 0 on a backend without the room scan (v2.1) — the page still works
      document.querySelectorAll('.room-only').forEach(function (el) { el.hidden = !S.roomSecs; });
      document.querySelectorAll('.b-room').forEach(function (el) { el.textContent = S.roomSecs + ' seconds'; });
      $('#w-role').textContent = r.roleTitle;
      $('#w-name').textContent = r.firstName;
      $('#w-total').textContent = r.total;
      $('#w-answer').textContent = fmtSecs(r.answer);
      var mins = Math.ceil(r.total * (r.answer + 20) / 60 / 5) * 5;
      $('#w-length').textContent = mins + ' min';
      $('#w-length2').textContent = 'about ' + mins + ' minutes';
      $('#w-deadline').textContent = r.deadline ? 'Please complete it by ' + r.deadline + '.' : '';
      document.querySelectorAll('.b-answer').forEach(function (e) { e.textContent = human(r.answer); });
      if (r.state === 'resume') {
        $('#w-resume').hidden = false;
        $('#w-resume-text').textContent = 'You reached question ' + r.reached + ' of ' + r.total + ' and saved ' + r.answered +
          ' answer' + (r.answered === 1 ? '' : 's') + '. The question that was on screen when the page closed is now closed and can’t be retaken. You can continue with the remaining questions.';
      }
      show('s-welcome');
    }).catch(function () { fatal('network'); });
  }

  // ------------------------------------------------------- device check --
  function setRow(id, state, text) {
    var el = $(id); el.classList.remove('ok', 'bad'); if (state) el.classList.add(state);
    if (text) el.querySelector('small').textContent = text;
  }
  function checkAlert(msg) { var a = $('#check-alert'); a.hidden = !msg; a.textContent = msg || ''; }
  function updateBegin() {
    $('#btn-begin').disabled = !(S.camOk && S.picOk && S.micOk && $('#consent').checked);
  }
  function startDevices() {
    checkAlert('');
    // iPhone/Safari only lets audio run if the AudioContext is created during the tap itself.
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !S.audioCtx) { try { S.audioCtx = new AC(); S.audioCtx.resume && S.audioCtx.resume(); } catch (e) { S.audioCtx = null; } }
    $('#btn-cam').disabled = true;
    $('#btn-cam').textContent = 'Waiting for permission…';
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    }).then(function (stream) {
      var v = stream.getVideoTracks()[0];
      if (!v || v.readyState !== 'live') {
        stream.getTracks().forEach(function (t) { t.stop(); });
        throw Object.assign(new Error('novideo'), { name: 'NoVideo' });
      }
      if (!stream.getAudioTracks()[0]) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        throw Object.assign(new Error('noaudio'), { name: 'NoAudio' });
      }
      S.stream = stream;
      ['#preview', '#preview-q'].forEach(function (s) { $(s).srcObject = stream; });
      $('#preview-empty').hidden = true;
      S.camOk = true;
      setRow('#ck-cam', 'ok', v.label ? 'Connected: ' + v.label : 'Connected');
      $('#btn-cam').hidden = true;
      watchPicture();
      watchMic(stream);
      v.onended = function () {
        S.camOk = false; S.picOk = false; updateBegin();
        if (interviewing()) { $('#cam-lost').hidden = false; beacon('camera_ended'); }
        else { setRow('#ck-cam', 'bad', 'Camera disconnected. Reload the page and try again.'); }
      };
      stream.getAudioTracks()[0].onended = function () { if (interviewing()) beacon('mic_ended'); };
      updateBegin();
    }).catch(function (e) {
      $('#btn-cam').disabled = false;
      $('#btn-cam').textContent = 'Try again';
      S.camOk = false; updateBegin();
      setRow('#ck-cam', 'bad', 'Not available');
      var n = e && e.name;
      checkAlert(
        n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera access was blocked. This interview requires your camera. Allow camera and microphone access for this site in your browser settings (usually the camera icon in the address bar), then select Try again.' :
        n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'NoVideo' ? 'We couldn’t find a camera. This interview requires video. Connect a camera or switch to a device that has one, then select Try again.' :
        n === 'NoAudio' ? 'We couldn’t find a microphone. Connect one and select Try again.' :
        n === 'NotReadableError' ? 'Your camera is being used by another app (for example Zoom or Teams). Close that app, then select Try again.' :
        'We couldn’t start your camera. Select Try again, or switch to another browser or device.');
    });
  }
  function watchPicture() {
    var v = $('#preview'); var c = document.createElement('canvas'); c.width = 64; c.height = 48;
    var g = c.getContext('2d', { willReadFrequently: true });
    clearInterval(S.picTimer);
    S.picTimer = setInterval(function () {
      if (S.phase !== 'idle') return clearInterval(S.picTimer);
      if (!v.videoWidth) { setRow('#ck-face', null, 'Starting camera…'); S.picOk = false; return updateBegin(); }
      g.drawImage(v, 0, 0, 64, 48);
      var d = g.getImageData(0, 0, 64, 48).data, sum = 0, sq = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) { var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += y; sq += y * y; }
      var mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      S.picOk = mean > 22 && sd > 6;
      setRow('#ck-face', S.picOk ? 'ok' : 'bad', S.picOk ? 'Picture looks good' : 'The picture is too dark or blank. Uncover the camera or add light.');
      updateBegin();
    }, 400);
  }
  function watchMic(stream) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { S.micOk = true; setRow('#ck-mic', 'ok', 'Connected'); return updateBegin(); }
    if (!S.audioCtx) { try { S.audioCtx = new AC(); } catch (e) { S.micOk = true; setRow('#ck-mic', 'ok', 'Connected'); return updateBegin(); } }
    // If the level meter can't run (some phones keep audio suspended), don't trap the candidate:
    // after 6 s a live microphone track counts as connected.
    setTimeout(function () {
      var t = stream.getAudioTracks()[0];
      if (!S.micOk && S.phase === 'idle' && t && t.readyState === 'live' && S.audioCtx && S.audioCtx.state !== 'running') {
        S.micOk = true; setRow('#ck-mic', 'ok', 'Connected (level meter unavailable on this device)'); updateBegin();
      }
    }, 6000);
    var resume = function () { if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume(); };
    document.addEventListener('click', resume, true); document.addEventListener('touchend', resume, true);
    var src = S.audioCtx.createMediaStreamSource(stream), an = S.audioCtx.createAnalyser();
    an.fftSize = 1024; src.connect(an);
    var buf = new Float32Array(an.fftSize);
    (function loop() {
      if (S.phase !== 'idle') return;
      an.getFloatTimeDomainData(buf);
      var rms = 0; for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);
      $('#mic-level').style.width = Math.min(100, rms * 600) + '%';
      if (!S.micOk && rms > 0.015) { S.micOk = true; setRow('#ck-mic', 'ok', 'We can hear you'); updateBegin(); }
      requestAnimationFrame(loop);
    })();
    if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  }

  // ---------------------------------------------------------- interview --
  // Continuous recording: one MediaRecorder segment per question, started BEFORE
  // the previous one stops (a few hundred ms of overlap, never a gap). Segment k
  // runs from the click that leads to question k until the click that leaves it.
  function pickMime() {
    var c = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }
  function startSegment(index) {
    var seg = { index: index, chunks: [], startedAt: Date.now(), shownAt: null, endedAt: null };
    var opts = { videoBitsPerSecond: 450000, audioBitsPerSecond: 64000 };
    if (S.mime) opts.mimeType = S.mime;
    seg.rec = new MediaRecorder(S.stream, opts);
    seg.rec.ondataavailable = function (e) { if (e.data && e.data.size) seg.chunks.push(e.data); };
    seg.rec.start(1000);
    return seg;
  }
  function cutSegment(seg) {
    return new Promise(function (resolve) {
      var rec = seg.rec;
      rec.onstop = function () {
        seg.endedAt = Date.now();
        resolve(new Blob(seg.chunks, { type: (rec.mimeType || S.mime || 'video/webm').split(';')[0] }));
      };
      try { rec.requestData(); } catch (e) {}
      try { rec.stop(); } catch (e) { resolve(new Blob(seg.chunks, { type: 'video/webm' })); }
    });
  }

  // ---- free in-browser transcript (Web Speech API; Chrome/Edge/Safari) ----
  var STT = { on: false, status: 'unsupported', results: [], starts: {}, gen: 0, inst: null };
  function sttStart() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { STT.status = 'unsupported'; return; }
    // On iPhone/iPad, Safari's speech recognition competes with the recorder for the microphone.
    // The server-side Whisper transcript covers these candidates.
    if (IS_IOS) { STT.status = 'skipped_ios'; return; }
    STT.on = true; STT.status = 'ok';
    (function make() {
      var gen = ++STT.gen, r;
      try { r = new SR(); } catch (e) { STT.status = 'error'; return; }
      r.continuous = true; r.interimResults = true; r.lang = 'en-US';
      r.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var key = gen + ':' + i;
          if (!(key in STT.starts)) STT.starts[key] = Date.now(); // when the phrase began
          if (e.results[i].isFinal) {
            var t = String(e.results[i][0].transcript || '').trim();
            if (t && !STT.starts[key + 'done']) { STT.starts[key + 'done'] = 1; STT.results.push({ at: STT.starts[key], text: t }); }
          }
        }
      };
      r.onerror = function (e) {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { STT.on = false; STT.status = 'blocked'; }
        else STT.status = 'partial:' + e.error;
        beacon('stt_error', e.error);
      };
      r.onend = function () { if (STT.on) setTimeout(function () { if (STT.on) make(); }, 250); };
      try { r.start(); STT.inst = r; } catch (e) { STT.status = 'error'; }
    })();
  }
  function sttStop() { STT.on = false; try { if (STT.inst) STT.inst.stop(); } catch (e) {} }
  function transcriptFor(seg) {
    var end = seg.cutAt || seg.endedAt || Date.now();
    return STT.results.filter(function (r) { return r.at >= (seg.fromAt || seg.startedAt) && r.at < end; })
      .map(function (r) { return { t: Math.max(0, (r.at - seg.startedAt) / 1000), text: r.text }; });
  }

  function begin() {
    $('#btn-begin').disabled = true;
    S.mime = pickMime();
    // Recording and transcription start on the click, before any question is shown.
    S.seg = startSegment(-1);
    sttStart();
    var v = S.stream.getVideoTracks()[0].getSettings ? S.stream.getVideoTracks()[0].getSettings() : {};
    // begin carries this page's cid, so a retried/duplicated begin can't look like "another tab".
    call('begin', { consent: true, client: { ua: UA.slice(0, 160), mime: S.mime, w: v.width, h: v.height, stt: STT.status, ios: IS_IOS, inApp: IN_APP } }, 4)
      .then(function (r) {
        if (!r.ok) return fatal(r.code);
        S.sid = r.sid; S.total = r.total;
        S.legacy = !(S.info && S.info.version); // v1 backend: upload must finish before the next reveal
        S.phase = 'question';
        lockNavigation();
        $('#q-text').textContent = '';
        $('#q-progress').textContent = 'Starting…';
        show('s-question');
        if (r.nextIndex >= r.total) return finishFlow();
        S.seg.index = r.nextIndex;
        S.expect = r.nextIndex;
        if (Number(r.room) > 0) return roomScan(Number(r.room));
        reveal();
      }).catch(function () {
        cutSegment(S.seg); sttStop(); S.seg = null;
        $('#btn-begin').disabled = false; toast('Connection problem. Please check your internet and select Start again.');
      });
  }

  // ---- room scan: recorded, before the first question of every session ----
  function roomScan(secs) {
    S.phase = 'room';
    S.seg.kind = 'room';
    $('#s-question').classList.add('room-mode');
    $('#q-progress').textContent = 'Room check · recording';
    $('#q-text').textContent = 'Before the first question: slowly turn your camera (or laptop or phone) all the way around the room, then show your desk and the area around your screen. Show that there is only one screen, no notes, phones, or other devices, and no one else in the room. Then face the camera again.';
    $('#phase-label').textContent = 'Show your room';
    $('#phase-label').className = 'phase';
    $('#phase-help').textContent = 'Keep moving slowly so we can see clearly. Only one screen is allowed.';
    $('#btn-next').textContent = 'Start question 1';
    setLoading(true, 'Starting the room check… you are on camera.');
    call('room', {}, 4).then(function (r) {
      if (!r.ok) return fatal(r.code);
      setLoading(false);
      var minEnd = Date.now() + secs * 1000, autoEnd = minEnd + 20000;
      $('#btn-next').disabled = true;
      clearInterval(S.tick);
      S.tick = setInterval(function () {
        var left = (minEnd - Date.now()) / 1000;
        $('#clock').textContent = fmtSecs(Math.max(0, left));
        $('#bar').style.width = Math.max(0, Math.min(100, left / secs * 100)) + '%';
        if (left <= 0) {
          $('#btn-next').disabled = false;
          $('#phase-help').textContent = 'Done? Face the camera and select Start question 1. It starts automatically in a few seconds.';
        }
        if (Date.now() >= autoEnd) leaveRoom();
      }, 250);
    }, function () { fatal('network'); });
  }
  function leaveRoom() {
    if (S.phase !== 'room') return;
    clearInterval(S.tick);
    $('#s-question').classList.remove('room-mode');
    S.phase = 'question';
    var old = S.seg;
    S.seg = startSegment(S.expect);   // new segment first: no off-camera gap
    old.cutAt = S.seg.startedAt;
    $('#q-text').textContent = '';
    $('#q-progress').textContent = 'Question ' + (S.expect + 1) + ' of ' + S.total;
    new Promise(function (res) { setTimeout(function () { cutSegment(old).then(res); }, 300); }).then(function (blob) {
      var p = uploadRoom(old, blob, 0); S.uploads.push(p); return p;
    });
    reveal();
  }
  function uploadRoom(seg, blob, attempt) {
    if (!blob || !blob.size) { beacon('room_upload_failed', 'empty recording'); return Promise.resolve(); }
    return toB64(blob).then(function (b64) {
      return api('upload', { kind: 'room', mime: blob.type, data: b64, durationMs: (seg.endedAt || Date.now()) - seg.startedAt }, 180000);
    }).then(function (r) {
      if (!r.ok) {
        if (r.code === 'busy' && attempt < 6) return wait(3000).then(function () { return uploadRoom(seg, blob, attempt + 1); });
        if (r.code === 'session_replaced') return fatal(r.code);
        beacon('room_upload_failed', r.code);
      }
    }, function () {
      if (S.phase === 'stopped' || attempt >= 6) { beacon('room_upload_failed', 'network'); return; }
      return wait(Math.min(16000, 2000 * Math.pow(2, attempt))).then(function () { return uploadRoom(seg, blob, attempt + 1); });
    });
  }
  function setLoading(on, msg) {
    $('#q-loading').hidden = !on;
    if (msg) $('#q-loading').textContent = msg;
    $('#btn-next').disabled = on;
  }
  // "want" tells the server which question this page expects. If a reveal is retried (lost
  // response, flaky network), the server re-sends that same question instead of skipping ahead.
  function reveal() {
    setLoading(true, 'Loading the next question… you are still on camera.');
    if (S.expect === undefined || S.expect === null) S.expect = S.index + 1;
    var payload = S.legacy ? {} : { want: S.expect };
    api('reveal', payload).then(function (r) {
      if (!r.ok) {
        if (r.code === 'answer_pending') return setTimeout(reveal, 1500); // v1 backend still saving
        if (r.code === 'busy') return setTimeout(reveal, 2000);
        return fatal(r.code);
      }
      if (r.done) return finishFlow();
      if (S.phase === 'answer' || S.phase === 'overtime') return; // a late duplicate response; already showing it
      S.index = r.index; S.total = r.total; S.answer = r.answer; S.overtime = r.overtime || 30;
      S.expect = r.index + 1;
      S.seg.index = r.index;
      S.seg.shownAt = Date.now();
      S.shownAt = Date.now();
      $('#q-progress').textContent = 'Question ' + (r.index + 1) + ' of ' + r.total;
      $('#q-text').textContent = r.text;
      $('#btn-next').textContent = r.index + 1 >= r.total ? 'Finish interview' : 'Next question';
      setLoading(false);
      // A re-sent question keeps the server's clock (no extra time from a retry).
      var used = Math.max(0, (Number(r.elapsedMs) || 0) / 1000);
      if (used >= S.answer) phase('overtime', Math.max(5, S.answer + S.overtime - used));
      else phase('answer', S.answer - used);
    }).catch(function () { if (S.phase !== 'stopped') { beacon('net_retry', 'reveal'); setTimeout(reveal, 2000); } });
  }
  function phase(name, secs) {
    S.phase = name; S.phaseLen = secs * 1000; S.phaseEnd = Date.now() + S.phaseLen;
    var label = $('#phase-label');
    label.textContent = name === 'answer' ? 'Answer now' : 'Time is up';
    label.className = 'phase' + (name === 'overtime' ? ' answer' : '');
    var last = S.index + 1 >= S.total;
    $('#phase-help').textContent = name === 'answer'
      ? 'You are recording. Think out loud and answer now. Click ' + (last ? 'Finish interview' : 'Next question') + ' when you are done.'
      : (last ? 'The interview will finish automatically.' : 'The next question will appear automatically.') + ' You are still recording.';
    S.doneArmed = 0;
    $('#btn-next').textContent = last ? 'Finish interview' : 'Next question';
    clearInterval(S.tick);
    var step = function () {
      var left = (S.phaseEnd - Date.now()) / 1000;
      $('#clock').textContent = fmtSecs(left);
      $('#bar').style.width = Math.max(0, Math.min(100, (S.phaseEnd - Date.now()) / S.phaseLen * 100)) + '%';
      if (left <= 0) {
        clearInterval(S.tick);
        if (S.phase === 'answer') { beacon('time_up'); phase('overtime', S.overtime); }
        else if (S.phase === 'overtime') goNext();
      }
    };
    step(); S.tick = setInterval(step, 250);
  }
  function goNext() {
    if (S.phase !== 'answer' && S.phase !== 'overtime') return;
    clearInterval(S.tick);
    if (S.index + 1 >= S.total) return finishFlow();
    S.phase = 'question';
    S.expect = S.index + 1;
    var old = S.seg;
    S.seg = startSegment(old.index + 1); // new segment first: no off-camera gap
    old.cutAt = S.seg.startedAt;         // transcript boundary (the video overlaps by ~0.3 s)
    $('#q-text').textContent = '';
    $('#q-progress').textContent = 'Question ' + (old.index + 2) + ' of ' + S.total;
    var saved = new Promise(function (res) { setTimeout(function () { cutSegment(old).then(res); }, 300); })
      .then(function (blob) { return queueUpload(old, blob, S.legacy ? 1500 : 2500); });
    if (S.legacy) { setLoading(true, 'Saving your answer… you are still on camera.'); saved.then(reveal); }
    else reveal();
  }
  S.uploads = [];
  function queueUpload(seg, blob, sttGraceMs) {
    var p = new Promise(function (res) { setTimeout(res, sttGraceMs); }).then(function () {
      return uploadSeg(seg, blob, transcriptFor(seg), 0);
    });
    S.uploads.push(p);
    return p;
  }
  function uploadSeg(seg, blob, transcript, attempt) {
    if (!blob || !blob.size) { beacon('upload_skipped', 'Q' + (seg.index + 1) + ' empty recording'); return Promise.resolve(); }
    return toB64(blob).then(function (b64) {
      return api('upload', {
        index: seg.index, mime: blob.type, data: b64, durationMs: (seg.endedAt || Date.now()) - seg.startedAt,
        shownOffsetMs: seg.shownAt ? seg.shownAt - seg.startedAt : 0, transcript: transcript, sttStatus: STT.status,
      }, 180000);
    }).then(function (r) {
      $('#q-saving').hidden = true;
      if (!r.ok) {
        if (r.code === 'too_late' || r.code === 'wrong_question' || r.code === 'question_closed') {
          toast('An earlier answer could not be saved in time.'); return;
        }
        if (r.code === 'busy') throw new Error('busy'); // retried below
        if (r.code === 'empty' || r.code === 'too_large') { // never end the whole interview over one file
          beacon('upload_skipped', 'Q' + (seg.index + 1) + ' ' + r.code); toast('One answer could not be saved. Please keep going.'); return;
        }
        fatal(r.code); throw new Error(r.code);
      }
    }, function () {
      if (S.phase === 'stopped') return;
      if (attempt === 0) beacon('upload_retry', 'Q' + (seg.index + 1));
      $('#q-saving').hidden = false;
      return new Promise(function (res) { setTimeout(res, Math.min(16000, 2000 * Math.pow(2, attempt))); })
        .then(function () { return uploadSeg(seg, blob, transcript, attempt + 1); });
    });
  }
  function toB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = rej; fr.readAsDataURL(blob);
    });
  }
  function finishFlow() {
    clearInterval(S.tick);
    S.phase = 'saving';
    $('#saving-msg').textContent = 'Saving your last answer and submitting your interview. Please keep this page open.';
    show('s-saving');
    var last = S.seg; S.seg = null;
    var lastUp = last && last.shownAt ? cutSegment(last).then(function (blob) {
      return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { sttStop(); return queueUpload(last, blob, 0); });
    }) : (last ? cutSegment(last) : Promise.resolve());
    lastUp.then(function () { return Promise.all(S.uploads.map(function (p) { return p.catch(function () {}); })); })
      .then(function finish() {
        if (S.phase === 'stopped') return;
        return api('finish').then(function (r) {
          if (!r.ok && (r.code === 'busy' || r.code === 'answer_pending') && (S.finishTries = (S.finishTries || 0) + 1) < 15) {
            return setTimeout(finish, 3000);
          }
          if (!r.ok) return fatal(r.code);
          S.phase = 'done';
          stopEverything();
          $('#d-name').textContent = (S.info && S.info.firstName) || '';
          show('s-done');
        }, function () { setTimeout(finish, 3000); });
      });
  }
  // ------------------------------------------------ navigation & focus --
  function lockNavigation() {
    history.pushState({ am: 1 }, '', location.href);
    window.addEventListener('popstate', function () {
      if (interviewing()) { history.pushState({ am: 1 }, '', location.href); toast('Going back isn’t available during the interview.'); beacon('back_blocked'); }
    });
  }
  window.addEventListener('beforeunload', function (e) {
    if (interviewing()) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
  window.addEventListener('pagehide', function () { if (interviewing()) beacon('page_closed', S.phase); });
  document.addEventListener('visibilitychange', function () {
    if (interviewing()) beacon(document.hidden ? 'tab_hidden' : 'tab_visible', S.phase);
  });
  var lastBlur = 0;
  window.addEventListener('blur', function () {
    if (interviewing() && Date.now() - lastBlur > 5000) { lastBlur = Date.now(); beacon('window_blur', S.phase); }
  });

  // ------------------------------------------------------------ wiring --
  $('#btn-to-check').addEventListener('click', function () { show('s-check'); });
  if ($('#err-copy')) $('#err-copy').addEventListener('click', function () {
    var link = location.href;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('Link copied. Paste it into Chrome or Safari.'); },
      function () { window.prompt('Copy this link and open it in Chrome or Safari:', link); });
  });
  $('#btn-cam').addEventListener('click', startDevices);
  $('#consent').addEventListener('change', updateBegin);
  $('#btn-begin').addEventListener('click', begin);
  $('#btn-next').addEventListener('click', function () {
    if (S.phase === 'room') return leaveRoom();
    if (S.phase !== 'answer' && S.phase !== 'overtime') return;
    // Guard against accidental skips: clicks in the first 2 s of a question (e.g. a double-click
    // carried over from the previous one) are ignored, and the confirming click must be a separate click.
    if (Date.now() - S.shownAt < 2000) { beacon('click_blocked', 'Q' + (S.index + 1) + ' early'); return; }
    var sinceArm = Date.now() - S.doneArmed;
    if (S.phase === 'overtime' || (sinceArm >= 400 && sinceArm < 5000)) return goNext();
    if (sinceArm < 400) return;
    S.doneArmed = Date.now();
    var last = S.index + 1 >= S.total;
    $('#btn-next').textContent = last ? 'Click again to finish (no retakes)' : 'Click again to move on (no going back)';
    setTimeout(function () { if (S.phase === 'answer') $('#btn-next').textContent = last ? 'Finish interview' : 'Next question'; }, 5000);
  });
  init();
})();
