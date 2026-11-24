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
    index: -1, total: 0, think: 30, answer: 150, phase: 'idle', phaseEnd: 0, phaseLen: 0, tick: null,
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
  function interviewing() { return ['between', 'think', 'answer', 'saving'].indexOf(S.phase) !== -1; }

  function api(action, payload) {
    var body = Object.assign({ action: action, token: S.token, sid: S.sid }, payload || {});
    return fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), redirect: 'follow', cache: 'no-store', credentials: 'omit',
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
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
    unsupported: ['Not supported', 'This browser can’t record your interview', 'Please open the link in a current version of Chrome, Edge, Firefox, or Safari on a device with a camera.'],
    network: ['Connection problem', 'We couldn’t reach the interview service', 'Check your internet connection and reload this page. If you had already started, the question that was on screen is closed and cannot be retaken.'],
    server_error: ['Problem', 'Something went wrong on our side', 'Please reply to your invitation email and let us know.'],
  };
  function fatal(code) {
    var e = ERR[code] || ERR.server_error;
    $('#err-badge').textContent = e[0];
    $('#err-badge').className = 'badge ' + (code === 'complete' ? 'badge-ok' : 'badge-warn');
    $('#err-title').textContent = e[1];
    $('#err-body').textContent = e[2];
    S.phase = 'stopped';
    stopEverything();
    show('s-error');
  }
  function stopEverything() {
    clearInterval(S.tick);
    try { if (S.recorder && S.recorder.state !== 'inactive') { S.recorder.onstop = null; S.recorder.stop(); } } catch (e) {}
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
    api('hello').then(function (r) {
      if (!r.ok) return fatal(r.code);
      if (r.state !== 'ready' && r.state !== 'resume') return fatal(r.state);
      S.info = r; S.total = r.total; S.think = r.think; S.answer = r.answer;
      $('#w-role').textContent = r.roleTitle;
      $('#w-name').textContent = r.firstName;
      $('#w-total').textContent = r.total;
      $('#w-think').textContent = fmtSecs(r.think);
      $('#w-answer').textContent = fmtSecs(r.answer);
      var mins = Math.ceil(r.total * (r.think + r.answer + 20) / 60 / 5) * 5;
      $('#w-length').textContent = mins + ' min';
      $('#w-length2').textContent = 'about ' + mins + ' minutes';
      $('#w-deadline').textContent = r.deadline ? 'Please complete it by ' + r.deadline + '.' : '';
      document.querySelectorAll('.b-think').forEach(function (e) { e.textContent = human(r.think); });
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
      ['#preview', '#preview-mini', '#preview-q'].forEach(function (s) { $(s).srcObject = stream; });
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
    S.audioCtx = new AC();
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
  function pickMime() {
    var c = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }
  function begin() {
    $('#btn-begin').disabled = true;
    S.mime = pickMime();
    var v = S.stream.getVideoTracks()[0].getSettings ? S.stream.getVideoTracks()[0].getSettings() : {};
    api('begin', { consent: true, client: { ua: navigator.userAgent.slice(0, 160), mime: S.mime, w: v.width, h: v.height } })
      .then(function (r) {
        if (!r.ok) return fatal(r.code);
        S.sid = r.sid; S.total = r.total;
        S.phase = 'between';
        lockNavigation();
        if (r.nextIndex >= r.total) return finish();
        between(r.nextIndex, false);
      }).catch(function () { $('#btn-begin').disabled = false; toast('Connection problem. Please try again.'); });
  }
  function between(nextIdx, justSaved) {
    S.phase = 'between';
    $('#b-progress').textContent = 'Question ' + (nextIdx + 1) + ' of ' + S.total;
    $('#b-title').textContent = justSaved ? 'Answer saved. Ready for question ' + (nextIdx + 1) + '?' : 'Ready for question ' + (nextIdx + 1) + '?';
    $('#btn-next').textContent = 'Show question ' + (nextIdx + 1);
    $('#btn-next').disabled = false;
    show('s-between');
  }
  function reveal() {
    $('#btn-next').disabled = true;
    api('reveal').then(function (r) {
      if (!r.ok) {
        if (r.code === 'answer_pending') { $('#btn-next').disabled = false; return toast('Still saving your last answer. Try again in a moment.'); }
        return fatal(r.code);
      }
      if (r.done) return finish();
      S.index = r.index; S.total = r.total; S.think = r.think; S.answer = r.answer;
      $('#q-progress').textContent = 'Question ' + (r.index + 1) + ' of ' + r.total;
      $('#q-text').textContent = r.text;
      $('#cam-lost').hidden = !(S.stream.getVideoTracks()[0].readyState !== 'live');
      startRecorder();
      show('s-question');
      phase('think', r.think);
    }).catch(function () { $('#btn-next').disabled = false; toast('Connection problem. Please try again.'); });
  }
  function startRecorder() {
    S.chunks = [];
    var opts = { videoBitsPerSecond: 450000, audioBitsPerSecond: 64000 };
    if (S.mime) opts.mimeType = S.mime;
    S.recorder = new MediaRecorder(S.stream, opts);
    S.recorder.ondataavailable = function (e) { if (e.data && e.data.size) S.chunks.push(e.data); };
    S.recorder.start(1000);
    S.recStart = Date.now();
  }
  function phase(name, secs) {
    S.phase = name; S.phaseLen = secs * 1000; S.phaseEnd = Date.now() + S.phaseLen;
    var label = $('#phase-label');
    label.textContent = name === 'think' ? 'Think' : 'Answer now';
    label.className = 'phase' + (name === 'answer' ? ' answer' : '');
    $('#phase-help').textContent = name === 'think'
      ? 'Recording has started. The answer timer begins automatically when this ends.'
      : 'Answer out loud to the camera. Recording stops automatically when time is up.';
    $('#btn-start-now').hidden = name !== 'think';
    $('#btn-done').hidden = name !== 'answer';
    $('#btn-done').textContent = 'Finish answer'; S.doneArmed = 0;
    clearInterval(S.tick);
    var step = function () {
      var left = (S.phaseEnd - Date.now()) / 1000;
      $('#clock').textContent = fmtSecs(left);
      $('#bar').style.width = Math.max(0, Math.min(100, (S.phaseEnd - Date.now()) / S.phaseLen * 100)) + '%';
      if (left <= 0) { clearInterval(S.tick); if (S.phase === 'think') phase('answer', S.answer); else if (S.phase === 'answer') endAnswer(); }
    };
    step(); S.tick = setInterval(step, 250);
  }
  function endAnswer() {
    if (S.phase !== 'answer' && S.phase !== 'think') return;
    clearInterval(S.tick);
    S.phase = 'saving';
    $('#saving-msg').textContent = 'Please keep this page open.';
    show('s-saving');
    var rec = S.recorder;
    rec.onstop = function () {
      var blob = new Blob(S.chunks, { type: (rec.mimeType || S.mime || 'video/webm').split(';')[0] });
      S.pendingBlob = { blob: blob, index: S.index, durationMs: Date.now() - S.recStart };
      upload(0);
    };
    try { rec.requestData(); } catch (e) {}
    rec.stop();
  }
  function toB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = rej; fr.readAsDataURL(blob);
    });
  }
  function upload(attempt) {
    var p = S.pendingBlob;
    toB64(p.blob).then(function (b64) {
      return api('upload', { index: p.index, mime: p.blob.type, data: b64, durationMs: p.durationMs });
    }).then(function (r) {
      if (!r.ok) {
        if (r.code === 'too_late' || r.code === 'wrong_question' || r.code === 'question_closed') {
          toast('That answer could not be saved in time. Continuing to the next question.');
          return afterSaved();
        }
        return fatal(r.code);
      }
      afterSaved();
    }).catch(function () {
      if (attempt < 4) {
        beacon('upload_retry', 'attempt ' + (attempt + 1));
        $('#saving-msg').textContent = 'Connection is slow. Retrying… (keep this page open)';
        return setTimeout(function () { upload(attempt + 1); }, 2000 * Math.pow(2, attempt));
      }
      $('#saving-msg').textContent = 'We could not save this answer. Check your connection; we will keep trying.';
      setTimeout(function () { upload(attempt); }, 8000);
    });
  }
  function afterSaved() {
    S.pendingBlob = null;
    if (S.index + 1 >= S.total) return finish();
    between(S.index + 1, true);
  }
  function finish() {
    S.phase = 'saving';
    $('#saving-msg').textContent = 'Submitting your interview…';
    show('s-saving');
    api('finish').then(function (r) {
      if (!r.ok) return fatal(r.code);
      S.phase = 'done';
      stopEverything();
      $('#d-name').textContent = (S.info && S.info.firstName) || '';
      show('s-done');
    }).catch(function () { setTimeout(finish, 3000); });
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
  $('#btn-cam').addEventListener('click', startDevices);
  $('#consent').addEventListener('change', updateBegin);
  $('#btn-begin').addEventListener('click', begin);
  $('#btn-next').addEventListener('click', reveal);
  $('#btn-start-now').addEventListener('click', function () { if (S.phase === 'think') phase('answer', S.answer); });
  $('#btn-done').addEventListener('click', function () {
    if (S.phase !== 'answer') return;
    if (Date.now() - S.doneArmed < 4000) return endAnswer();
    S.doneArmed = Date.now();
    $('#btn-done').textContent = 'Click again to finish (no retakes)';
    setTimeout(function () { if (S.phase === 'answer') $('#btn-done').textContent = 'Finish answer'; }, 4000);
  });
  init();
})();
