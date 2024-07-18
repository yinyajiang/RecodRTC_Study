function IsEdge() {
    if (typeof window.__isEdge !== 'undefined') {
        return window.__isEdge;
    }
    window.__isEdge = navigator.userAgent.indexOf('Edge') !== -1 && (!!navigator.msSaveOrOpenBlob || !!navigator.msSaveBlob);
    return window.__isEdge;
}

function IsSafari() {
    if (typeof window.__isSafari !== 'undefined') {
        return window.__isSafari;
    }
    window.__isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    return window.__isSafari;
}

function IsFirefox() {
    return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
}

function DispatchClick(element) {
    const event = new MouseEvent('click', {
        'view': window,
        'bubbles': true,
        'cancelable': true
    });
    element.dispatchEvent(event);
}

function GetStreamInfo(stream, defaultInfo) {
    if (!stream) return;
    const videoTracks = stream.getVideoTracks();
    if (!videoTracks.length) {
        if (!defaultInfo) {
            return { width: 0, height: 0, aspectRatio: -1 };
        }
        if (!defaultInfo.aspectRatio && defaultInfo.width && defaultInfo.height) {
            defaultInfo.aspectRatio = defaultInfo.width / defaultInfo.height;
        }
        return Object.assign({ width: 0, height: 0, aspectRatio: -1 }, defaultInfo);
    }
    const settings = videoTracks[0].getSettings();
    if (!settings.aspectRatio && settings.width && settings.height) {
        settings.aspectRatio = settings.width / settings.height;
    }
    return {
        width: settings.width,
        height: settings.height,
        aspectRatio: settings.aspectRatio,
    };
}

function CorrectWH({ width, height }, maxW) {
    if (width > maxW) {
        height = Math.floor(height * (maxW / width));
        width = Math.floor(maxW);
    }
    return { width, height };
}

class MediaRecorderApp {
    onStop(callback) {
        this._addHook('stop', callback);
    }
    onStart(callback) {
        this._addHook('start', callback);
    }
    onPause(callback) {
        this._addHook('pause', callback);
    }
    onResume(callback) {
        this._addHook('resume', callback);
    }
    onCaptureBefore(callback) {
        this._addHook('capturebefore', callback);
    }
    onCaptureSuccess(callback) {
        this._addHook('captureafter', callback);
    }
    onCaptureError(callback) {
        this._addHook('captureerror', callback);
    }
    onUpdateRecordTime(callback) {
        this._addHook('updateRecordTime', callback);
    }

    discard() {
        this._destroy(true);
    }

    async start({ captures }) {
        if (!captures.camera && !captures.microphone && !captures.screen && !captures.systemAudio) {
            console.log('Please select at least one media source to record.');
            return;
        }
        this._stop = false;
        this._destroy(false);

        this._callback('capturebefore', captures);
        this._recordStreams = await this._captureRecordStreams(captures);
        this._callback('captureafter', this._recordStreams);

        this._recordOptions = {};
        if (this._recordStreams.isVideo) {
            console.log("record videoinfo:" + JSON.stringify(this._recordStreams.videoInfo));

            this._recordOptions = Object.assign(this._recordOptions, {
                type: 'video',
                mimeType: 'video/webm',
                video: {
                    width: this._recordStreams.videoInfo.width ? this._recordStreams.videoInfo.width : 1920,
                    height: this._recordStreams.videoInfo.height ? this._recordStreams.videoInfo.height : 1080,
                },
            });
        } else {
            let audioOptions = {
                type: 'audio',
            };
            if (IsSafari() || IsEdge()) {
                audioOptions.recorderType = StereoAudioRecorder;
                audioOptions.numberOfAudioChannels = IsEdge() ? 1 : 2;
            }
            this._recordOptions = Object.assign(this._recordOptions, audioOptions);
        }

        this._recordOptions.previewStream = (preview) => {
            this._callback('start', { isVideo: this._isRecordVideo(), preview });
        };

        console.log("record options:" + JSON.stringify(this._recordOptions));
        this._recorder = RecordRTC(this._recordStreams, this._recordOptions);

        this._recorder.startRecording();

        this._startCalculateTime();
    }

    stop() {
        if (this._stop) return;
        this._stop = true;
        if (!this._recorder) return;
        this._recorder.stopRecording((blobURL) => {
            this._stopStream();
            this._callback('stop', { isVideo: this._isRecordVideo(), blobURL });
        });
    }

    async download(seekable) {
        return new Promise((resolve, reject) => {
            if (!this._recorder) {
                reject("recorder is not ready yet");
                return;
            }
            let blob = this._recorder.getBlob();
            if (!blob) {
                reject("blob is not ready yet");
                return;
            };
            const ext = this._isRecordVideo() ? "webm" : "mp3";
            if (seekable) {
                getSeekableBlob(blob, (seekableBlob) => {
                    const blobURL = URL.createObjectURL(seekableBlob);
                    this._saveURLToDisk(blobURL, ext);
                    resolve();
                });
            } else {
                const blobURL = URL.createObjectURL(blob);
                this._saveURLToDisk(blobURL, ext);
                resolve();
            }
        })


    }

    pause() {
        if (this._recorder) {
            this._callback('pause');
            this._recorder.pauseRecording();
            this._pauseCalculateTime();
        }
    }

    state() {
        return this._recorder.getState();
    }

    blog() {
        return this._recorder.getBlob();
    }

    resume() {
        if (this._recorder) {
            this._callback('resume');
            this._recorder.resumeRecording();
            this._startCalculateTime()
        }
    }

    _addHook(event, callback) {
        if (!event || !callback) return;
        if (!this._hooks) {
            this._hooks = {};
        }
        if (!this._hooks[event]) {
            this._hooks[event] = [];
        }
        this._hooks[event].push(callback);
    }

    _hasHook(event) {
        if (!event || !this._hooks) return false;
        return !!this._hooks[event];
    }

    _callback(event, ...args) {
        if (!event || !this._hooks) return;
        const callbacks = this._hooks[event];
        if (callbacks) {
            callbacks.forEach(callback => callback(...args));
        }
    }

    async _captureRecordStreams(captures) {
        try {
            let streams = [];
            if (captures.screen) {
                let constraints = {
                    video: true,
                    audio: !!captures.systemAudio
                }
                let retryConstraints = captures.systemAudio ? { video: true } : null;

                const screen = await this._getDisplayMedia(constraints, retryConstraints);
                screen.__info = GetStreamInfo(screen, {
                    width: window.screen.width,
                    height: window.screen.height,
                });
                console.log("screen:" + JSON.stringify(screen.__info));

                streams.screen = screen;
                streams.isVideo = true;
                streams.systemAudio = constraints.audio;
                streams.push(screen);
                captures.systemAudio = constraints.audio;

                const keepStreamActive = document.createElement('video');
                keepStreamActive.muted = true;
                keepStreamActive.srcObject = screen;
                keepStreamActive.style.display = 'none';
                (document.body || document.documentElement).appendChild(keepStreamActive);
                this.onStop(() => {
                    keepStreamActive.srcObject = null;
                    (document.body || document.documentElement).removeChild(keepStreamActive);
                })
            }
            if (!streams.systemAudio && captures.systemAudio) {
                const systemAudio = await this._getDisplayMedia({ audio: true }, null, streams.length > 0);
                if (systemAudio) {
                    streams.systemAudio = systemAudio;
                    streams.push(systemAudio);
                } else {
                    captures.systemAudio = false;
                }
            }
            if (captures.camera) {
                let constraints = {
                    video: true,
                    audio: !!captures.microphone
                }
                let retryConstraints = captures.microphone ? { video: true } : null;

                const camera = await this._getUserMedia(constraints, retryConstraints);

                camera.__info = GetStreamInfo(camera, {
                    width: 1920,
                    height: 1080,
                });
                console.log("camera:" + JSON.stringify(camera.__info));

                streams.camera = camera;
                streams.isVideo = true;
                streams.microphone = constraints.audio;
                streams.push(camera);
                captures.microphone = constraints.audio;
            }
            if (!streams.microphone && captures.microphone) {
                const microphone = await this._getUserMedia({ audio: true }, null, streams.length > 0)
                if (microphone) {
                    streams.microphone = microphone
                    streams.push(microphone);
                } else {
                    captures.microphone = false;
                }
            }
            if (streams.screen && streams.camera) {
                let screenWH = CorrectWH(streams.screen.__info, 1920);

                streams.screen.width = screenWH.width;
                streams.screen.height = screenWH.height;
                streams.screen.fullcanvas = true;

                let cameraWH = CorrectWH(streams.camera.__info, Math.min(streams.screen.width * 0.15, 320));
                streams.camera.width = cameraWH.width;
                streams.camera.height = cameraWH.height;

                streams.camera.top = streams.screen.height - streams.camera.height;
                streams.camera.left = streams.screen.width - streams.camera.width;

                streams.videoInfo = {
                    width: streams.screen.width,
                    height: streams.screen.height,
                    cameraWidth: streams.camera.width,
                    cameraHeight: streams.camera.height,
                }
            } else if (streams.screen) {
                let { width, height } = CorrectWH(streams.screen.__info, 1920);
                streams.videoInfo = {
                    width: width,
                    height: height,
                };
            } else if (streams.camera) {
                let { width, height } = CorrectWH(streams.camera.__info, 1920);
                streams.videoInfo = {
                    width: width,
                    height: height,
                };
            }

            if (Array.isArray(streams)) {
                streams.forEach(stream => this._addStreamStopListener(stream, () => this.stop()));
            } else {
                this._addStreamStopListener(streams, () => this.stop());
            }
            return streams;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }

    async _getUserMedia(constraints, retryConstraints, noException = false) {
        if (typeof navigator.mediaDevices === 'undefined' || !navigator.mediaDevices.getUserMedia) {
            alert('This browser does not supports WebRTC getUserMedia API.');
            throw new Error('getUserMedia is not supported by this browser');
        }
        try {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e) {
                if (retryConstraints) {
                    console.log("getUserMedia use retryConstraints:" + JSON.stringify(retryConstraints));
                    const res = await navigator.mediaDevices.getUserMedia(retryConstraints);
                    constraints.video = !!retryConstraints.video;
                    constraints.audio = !!retryConstraints.audio;
                    return res;
                } else {
                    throw e;
                }
            }
        } catch (e) {
            if (noException) {
                console.log("getUserMedia failed, but continue:" + e);
                return
            }
            this._callback('captureerror', {
                error: e,
                camera: constraints.video,
                microphone: constraints.audio,
            });
            throw e;
        }
    }

    async _getDisplayMedia(constraints, retryConstraints, noException = false) {
        if (!navigator.getDisplayMedia && !navigator.mediaDevices.getDisplayMedia) {
            alert('This browser does not supports WebRTC getDisplayMedia API.');
            throw new Error('getDisplayMedia is not supported by this browser');
        }
        try {
            try {
                return await navigator.mediaDevices.getDisplayMedia(constraints);
            } catch (e) {
                if (retryConstraints) {
                    console.log("getDisplayMedia use retryConstraints:" + JSON.stringify(retryConstraints));
                    const res = await navigator.mediaDevices.getDisplayMedia(retryConstraints);
                    constraints.video = !!retryConstraints.video;
                    constraints.audio = !!retryConstraints.audio;
                    return res;
                } else {
                    throw e;
                }
            }
        } catch (e) {
            if (noException) {
                console.log("getDisplayMedia failed, but continue:" + e);
                return;
            }
            this._callback('captureerror', {
                error: e,
                screen: constraints.video,
                systemAudio: constraints.audio,
            });
            throw e;
        }
    }

    _addStreamStopListener(stream, callback) {
        if (!stream || !callback) {
            return;
        }
        stream.addEventListener('ended', () => {
            callback();
            callback = () => { };
        }, false);
        stream.addEventListener('inactive', () => {
            callback();
            callback = () => { };
        }, false);
        stream.getTracks().forEach((track) => {
            track.addEventListener('ended', () => {
                callback();
                callback = () => { };
            }, false);
            track.addEventListener('inactive', () => {
                callback();
                callback = () => { };
            }, false);
        });
    }

    _saveURLToDisk(fileURL, ext, prefix = "redord-") {
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0'); // 月份从0开始，需要加1
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        const fileName = prefix + formattedDateTime + '.' + ext;

        // for non-IE
        if (!window.ActiveXObject) {
            let save = document.createElement('a');
            save.href = fileURL;
            save.download = fileName || 'unknown';
            save.style = 'display:none;opacity:0;color:transparent;';
            (document.body || document.documentElement).appendChild(save);
            if (typeof save.click === 'function') {
                save.click();
            } else {
                save.target = '_blank';
                DispatchClick(save);
            }
            (window.URL || window.webkitURL).revokeObjectURL(save.href);
        }
        // for IE
        else if (!!window.ActiveXObject && document.execCommand) {
            let _window = window.open(fileURL, '_blank');
            _window.document.close();
            _window.document.execCommand('SaveAs', true, fileName || fileURL)
            _window.close();
        }
    }

    _stopStream() {
        this._stopCalculateTime();
        if (!this._recordStreams) return;
        const callStop = (obj) => {
            if (obj && typeof obj.stop === 'function') {
                obj.stop();
            }
            if (obj && typeof obj.getTracks === 'function') {
                obj.getTracks().forEach(track => {
                    track.stop();
                })
            }
        }
        callStop(this._recordStreams.camera);
        callStop(this._recordStreams.microphone);
        callStop(this._recordStreams.screen);
        callStop(this._recordStreams.systemAudio);
        if (Array.isArray(this.recordStreams)) {
            for (const stream of this._recordStreams) {
                callStop(stream)
            }
            callStop(this._recordStreams);
        }
        this._recordStreams = null;
    };

    _destroy(reset) {
        this._stopStream();
        if (reset && this._recorder) {
            this._recorder.reset();
        }
        if (this._recorder) {
            this._recorder.destroy();
        }
        this._recorder = null;
    };

    _isRecordVideo() {
        return this._recordOptions && this._recordOptions.type === 'video'
    }


    _stopCalculateTime() {
        this._pauseCalculateTime();
        this._lastMillis = 0;
    }
    _pauseCalculateTime() {
        if (this._calculateTimer) {
            clearTimeout(this._calculateTimer);
            this._calculateTimer = null;
        }
    }
    _startCalculateTime() {
        if (!this._recorder || !this._recordStreams) {
            return;
        }
        this._startTime = new Date().getTime();
        if (this._lastMillis) {
            this._startTime -= this._lastMillis;
            this._lastMillis = 0;
        }
        this._calculateTimer = setInterval(() => this._calculateTime(), 1000);
    }
    _calculateTime() {
        if (!this._recorder || !this._recordStreams || !this._startTime) {
            return;
        }
        const millis = new Date().getTime() - this._startTime;
        this._lastMillis = millis;

        const secs = millis / 1000;
        let hr = Math.floor(secs / 3600);
        let min = Math.floor((secs - (hr * 3600)) / 60);
        let sec = Math.floor(secs - (hr * 3600) - (min * 60));
        if (min < 10) {
            min = "0" + min;
        }
        if (sec < 10) {
            sec = "0" + sec;
        }
        if (hr <= 0) {
            this._callback('updateRecordTime', `${min}:${sec}`);
        } else {
            this._callback('updateRecordTime', `${hr}:${min}:${sec}`);
        }
    }
}


class SpeakingListener {
    listen({ stream, timeoutSeconds }) {
        this._timeoutHandle;
        this._hark = hark(stream, {});
        this._hark.on('speaking', () => {
            if (this._timeoutHandle) {
                clearTimeout(this._timeoutHandle);
                this._timeoutHandle = null;
            }
            if (this._speakingHooks) {
                this._speakingHooks.forEach(callback => callback());
            }
        });
        this._hark.on('stopped_speaking', () => {
            this._timeoutHandle = setTimeout(() => {
                if (this._stopSpeakingHooks) {
                    this._stopSpeakingHooks.forEach(callback => callback());
                }
            }, timeoutSeconds * 1000);
        });
    }

    stop() {
        if (this._hark) {
            this._hark.stop();
            this._hark = null;
        }
        if (this._timeoutHandle) {
            clearTimeout(this._timeoutHandle);
            this._timeoutHandle = null;
        }
    }
    onSpeaking(callback) {
        if (this._speakingHooks) {
            this._speakingHooks.push(callback);
        } else {
            this._speakingHooks = [callback];
        }
    }
    onStopSpeaking(callback) {
        if (this._stopSpeakingHooks) {
            this._stopSpeakingHooks.push(callback);
        } else {
            this._stopSpeakingHooks = [callback];
        }
    }
}

class CanvasDrawAudio {
    start({ stream, canvas, barOptions }) {
        this._canvas = canvas;
        this._barOptions = Object.assign({
            barWidth: 8,
            barSpacing: 10,
            barCount: 15,
            barColor: '#ffffff',
            barMinHeight: 8,
        }, barOptions);

        this._ctx2d = this._canvas.getContext('2d');
        this._ctx2d.fillStyle = this._barOptions.barColor;

        // 创建音频上下文和分析器
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this._analyser = this._audioContext.createAnalyser();
        this._analyser.fftSize = 32;

        const source = this._audioContext.createMediaStreamSource(stream);
        source.connect(this._analyser);

        const bufferLength = this._analyser.frequencyBinCount;
        this._dataArray = new Uint8Array(bufferLength);
        this._draw();
    }

    async stop() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
        if (this._ctx2d) {
            this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
            this._ctx2d = null;
        }
        if (this._audioContext) {
            await this._audioContext.close();
            this._audioContext = null;
        }
        this._analyser = null;
        this._canvas = null;
    }

    // 绘制函数
    _draw() {
        this._analyser.getByteFrequencyData(this._dataArray);
        this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
        const centerY = this._canvas.height / 2;
        const startX = (this._canvas.width - (this._barOptions.barWidth + this._barOptions.barSpacing) * this._barOptions.barCount + this._barOptions.barSpacing) / 2;

        for (let i = 0; i < this._barOptions.barCount; i++) {

            let barHeight = (this._dataArray[i * 2] / 255) * this._canvas.height;
            barHeight = Math.max(barHeight, this._barOptions.barMinHeight);

            const x = startX + (this._barOptions.barWidth + this._barOptions.barSpacing) * i;
            this._ctx2d.fillRect(Math.floor(x), Math.floor(centerY - barHeight / 2), this._barOptions.barWidth, Math.floor(barHeight));
        }
        this._animationId = requestAnimationFrame(() => this._draw());
    }
}


function clickEle(element) {
    const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
    });
    element.dispatchEvent(event);
}
function enableEle(enable, ...eles) {
    eles.forEach(ele => ele.disabled = !enable);
}
function showEle(show, ...eles) {
    if (show) {
        eles.forEach(ele => {
            if (ele) {
                ele.classList.remove('display-none')
            }
        });
    } else {
        eles.forEach(ele => {
            if (ele) {
                ele.classList.add('display-none')
            }
        });
    }
}

function addPlayPauseFun(element) {
    if (!element) return;
    element.onplaying = () => element.__isPlaying = true;
    element.onpause = () => element.__isPlaying = false;
    element.onended = () => element.__isPlaying = false;

    element._PauseFun = () => {
        if (element.played && element.__isPlaying) {
            element.pause();
        }
    }
    element._PlayFun = () => {
        if (element.paused && !element.__isPlaying) {
            element.play();
        }
    }
}

function setPlaySrc(ele, src, muted) {
    ele.src = ele.srcObject = null;
    if (typeof (src) === 'string') {
        ele.src = src;
    } else {
        ele.srcObject = src;
    }
    ele.muted = muted;
    ele.load();
}

function showLoading(bottom) {
    hideLoading();
    const apploading = document.createElement('div');
    apploading.classList.add('app-loader');
    if (bottom) {
        apploading.style.bottom = bottom;
    }
    document.body.appendChild(apploading);
}
function hideLoading() {
    let apploading = document.querySelector('.app-loader');
    if (apploading) {
        apploading.remove();
    }
}

function selectedIcon(selectors) {
    for (const selector of ["#screen-icon", "#camera-icon", "#microphone-icon", "#system-audio-icon"]) {
        if (!selectors.includes(selector)) {
            document.querySelector(selector).classList.add('device-icon');
        } else {
            document.querySelector(selector).classList.remove('device-icon');
            document.querySelector(selector).classList.add('device-selected-icon');
        }
    }
}





let lastCaptureSuccess = false;
async function intoRecording() {
    let app = new MediaRecorderApp();
    let audioDrawer = new CanvasDrawAudio();
    let speakListen = new SpeakingListener();

    const microphoneCheck = localStorage.getItem('microphone') == '1';
    const screenCheck = localStorage.getItem('screen') == '1';
    const cameraCheck = localStorage.getItem('camera') == '1';
    const systemAudioCheck = localStorage.getItem('systemAudio') == '1';
    const speakTimeout = localStorage.getItem('speakTimeout') ? parseInt(localStorage.getItem('speakTimeout')) : 0;

    const backBtn = document.querySelector('#btn-back');
    backBtn.onclick = (event) => {
        event.preventDefault();
        app.discard();
        window.location.href = "/online-recorder#quick-start";
    }
    if (!microphoneCheck && !screenCheck && !cameraCheck && !systemAudioCheck) {
        window.location.href = "/online-recorder#quick-start";
        return;
    }

    selectedIcon([
        microphoneCheck ? "#microphone-icon" : null,
        screenCheck ? "#screen-icon" : null,
        cameraCheck ? "#camera-icon" : null,
        systemAudioCheck ? "#system-audio-icon" : null,
    ])

    const preparePage = document.querySelector('#app-page-prepare');
    const recordPage = document.querySelector('#app-page-record');
    const errorMsg = document.querySelector("#error-message");
    const finishTips = document.querySelector("#finish-tips");

    const stopBtn = document.querySelector('#btn-stop');
    const pauseBtn = document.querySelector('#btn-pause');
    const resumeBtn = document.querySelector('#btn-resume');
    const downloadBtn = document.querySelector('#btn-download');
    const discardBtn = document.querySelector('#btn-discard');
    const retryBtn = document.querySelector('#btn-retry');
    const seakableCheck = document.querySelector('#chk-seekable');
    const seakableContainer = document.querySelector('#chk-seekable-container');

    if (!seakableContainer.__has_toolstip) {
        tippy('#seekable-toolstip', {
            content: "Add the duration attribute to the recorded file.",
        });
        seakableContainer.__has_toolstip = true;
    }

    const recordTimeIcon = document.querySelector('#record-timer');
    function setRecordIcon(recording) {
        if (recording) {
            recordTimeIcon.classList.remove('not-recording-timer');
            recordTimeIcon.classList.add('recording-timer');
        } else {
            recordTimeIcon.classList.remove('recording-timer');
            recordTimeIcon.classList.add('not-recording-timer');
        }
    }

    const recordTime = document.querySelector('#record-timer .uagb-heading-text');

    const audioCanvas = document.querySelector('#audio-draw-canvas');
    const videoPreview = document.querySelector('#video-preview');
    const audioPreview = document.querySelector('#audio-preview');
    addPlayPauseFun(videoPreview);
    addPlayPauseFun(audioPreview);


    app.onCaptureBefore(() => {
        setRecordIcon(false);
        showEle(false, errorMsg, finishTips);
        videoPreview.controls = false;
        audioPreview.controls = false;
        if (lastCaptureSuccess && !screenCheck.checked) {
            showEle(true, recordPage);
            showEle(false, preparePage);
        } else {
            showEle(false, recordPage);
            showEle(true, preparePage);
            showLoading();
        }
    });
    app.onCaptureSuccess((recordStreams) => {
        lastCaptureSuccess = true;
        hideLoading();
        showEle(true, recordPage, stopBtn, pauseBtn);
        enableEle(false, stopBtn, pauseBtn, resumeBtn);
        showEle(false, preparePage, downloadBtn, seakableContainer, discardBtn, retryBtn, resumeBtn);

        if (recordStreams.isVideo) {
            showEle(false, audioPreview);
            showEle(false, audioCanvas);
        } else {
            showEle(false, videoPreview);
        }

        setRecordIcon(true);
    });
    app.onCaptureError((errorObj) => {
        hideLoading();

        let errorDevices = [];
        if (errorObj.camera) {
            errorDevices.push('Camera');
        }
        if (errorObj.microphone) {
            errorDevices.push('Microphone');
        }
        if (errorObj.screen) {
            errorDevices.push('Screen');
        }
        if (errorObj.systemAudio) {
            errorDevices.push('System Audio');
        }
        showEle(true, errorMsg);
        console.log("Cannot capture " + errorDevices.join(' and ') + ". Error: " + errorObj.error.message);
    });
    app.onStart(({ isVideo, preview }) => {
        enableEle(true, stopBtn, pauseBtn);
        enableEle(false, resumeBtn);

        if (speakTimeout && speakTimeout > 0 && recordStreams.microphone) {
            speakListen.listen({
                stream: preview,
                timeoutSeconds: speakTimeout,
            })
        }

        if (isVideo && preview) {
            setPlaySrc(videoPreview, preview, true);
        }
        if (!isVideo && preview) {
            showEle(false, audioPreview);
            showEle(true, audioCanvas);
            audioDrawer.start({
                stream: preview,
                canvas: audioCanvas,
            });
        }
    });
    app.onStop(({ isVideo, blobURL }) => {
        showEle(false, stopBtn, pauseBtn, resumeBtn);
        showEle(true, downloadBtn, seakableContainer, discardBtn, retryBtn, finishTips);
        seakableCheck.checked = true;
        enableEle(true, downloadBtn, discardBtn, retryBtn);

        speakListen.stop()
        audioDrawer.stop();
        if (isVideo) {
            videoPreview.controls = true;
            setPlaySrc(videoPreview, blobURL, false);
        } else {
            showEle(false, audioCanvas);
            showEle(true, audioPreview);
            audioPreview.controls = true;
            setPlaySrc(audioPreview, blobURL, false);
        }

        setRecordIcon(false);
    });
    app.onPause(() => {
        showEle(false, pauseBtn);
        showEle(true, resumeBtn);

        enableEle(false, pauseBtn);
        enableEle(true, stopBtn, resumeBtn);
        videoPreview._PauseFun();

        setRecordIcon(false);
    });
    app.onResume(() => {
        showEle(false, resumeBtn);
        showEle(true, pauseBtn);

        enableEle(false, resumeBtn);
        enableEle(true, stopBtn, pauseBtn);
        videoPreview._PlayFun();

        setRecordIcon(true);
    });
    app.onUpdateRecordTime((time) => recordTime.innerHTML = time);

    speakListen.onSpeaking(() => {
        console.log('speaking');
        if (!resumeBtn.disabled) {
            DispatchClick(resumeBtn);
        }
    });
    speakListen.onStopSpeaking(() => {
        console.log('stop speaking');
        if (!pauseBtn.disabled) {
            DispatchClick(pauseBtn);
        }
    });

    stopBtn.onclick = (event) => {
        event.preventDefault();
        app.stop();
    }
    pauseBtn.onclick = (event) => {
        event.preventDefault();
        app.pause();
    }
    resumeBtn.onclick = (event) => {
        event.preventDefault();
        app.resume();
    }
    downloadBtn.onclick = async (event) => {
        event.preventDefault();
        enableEle(false, downloadBtn);
        showLoading();
        await app.download(seakableCheck.checked);
        hideLoading();
        enableEle(true, downloadBtn);
    };
    discardBtn.onclick = (event) => {
        event.preventDefault();
        app.discard();
        setPlaySrc(videoPreview, null, true);
        setPlaySrc(audioPreview, null, true);
        recordTime.innerHTML = "00:00";
        setRecordIcon(false);

        showEle(true, retryBtn);
        enableEle(true, retryBtn);
        showEle(false, stopBtn, pauseBtn, resumeBtn, downloadBtn, seakableContainer, discardBtn);
    };
    retryBtn.onclick = (event) => {
        event.preventDefault();
        intoRecording();
    }

    await app.start({
        captures: {
            camera: cameraCheck,
            microphone: microphoneCheck,
            screen: screenCheck,
            systemAudio: systemAudioCheck,
        },
    });
}

const isRecordScreen = localStorage.getItem('screen') == '1'
if (isRecordScreen && IsFirefox()) {
    const confirmPage = document.querySelector('#app-page-confirm');
    const preparePage = document.querySelector('#app-page-prepare');
    const recordPage = document.querySelector('#app-page-record');
    showEle(false, preparePage, recordPage);
    showEle(true, confirmPage);
}

window.addEventListener('DOMContentLoaded', async () => {
    const confirmPage = document.querySelector('#app-page-confirm');
    const preparePage = document.querySelector('#app-page-prepare');
    const recordPage = document.querySelector('#app-page-record');

    if (isRecordScreen && IsFirefox()) {
        showEle(false, preparePage, recordPage);
        showEle(true, confirmPage);
        const backBtn = document.querySelector('#btn-back');
        backBtn.onclick = (event) => {
            event.preventDefault();
            window.location.href = "/online-recorder#quick-start";
        }
        document.querySelector('#btn-confirm-start').onclick = async (event) => {
            event.preventDefault();
            showEle(true, preparePage);
            showEle(false, confirmPage, recordPage);
            await intoRecording();
        }
    } else {
        showEle(true, preparePage);
        showEle(false, confirmPage, recordPage);
        await intoRecording();
    }
});