// Copyright (c) 2015-2017 Robert Rypuła - https://audio-network.rypula.pl
'use strict';

var PhysicalLayer;

PhysicalLayer = function (statusHandler, configuration) {
    var
        c = configuration || {},
        vod = PhysicalLayer.$$getValueOrDefault;

    // TODO implement builder class that will replace configuration object
    this.$$sampleTimeMs = vod(c.sampleTimeMs, 250);
    this.$$samplePerSymbol = vod(c.samplePerSymbol, 3);
    this.$$fftSize = vod(c.fftSize, 8 * 1024);
    this.$$fftFrequencyBinSkipFactor = vod(c.fftFrequencyBinSkipFactor, 3);
    this.$$symbolMin = vod(c.symbolMin, 98);
    this.$$symbolMax = vod(c.symbolMax, (this.$$symbolMin - 1) + 256 + 2);     // 8-bit data (256 symbol), connection signal (2 symbols)
    this.$$symbolSyncA = vod(c.symbolSyncA, this.$$symbolMax - 1);
    this.$$symbolSyncB = vod(c.symbolSyncB, this.$$symbolMax - 0);
    this.$$txAmplitude = vod(c.txAmplitude, 0.1);
    this.$$rxSignalThresholdFactor = vod(c.rxSignalThresholdFactor, 0.85);

    this.$$sampleNumber = 0;
    this.$$offset = undefined;
    this.$$symbol = undefined;
    this.$$signalDecibel = undefined;
    this.$$noiseDecibel = undefined;
    this.$$frequencyDataReceiveBand = undefined;
    this.$$fftResult = undefined;
    this.$$isSymbolSamplingPoint = undefined;
    this.$$isSymbolReadyToTake = undefined;
    this.$$txCurrentSymbol = undefined;
    this.$$txSymbolQueue = [];

    this.$$statusHandler = PhysicalLayer.$$isFunction(statusHandler) ? statusHandler : null;
    this.$$audioMonoIO = new AudioMonoIO(this.$$fftSize);
    this.$$connectSignalDetector = new ConnectSignalDetector(this.$$samplePerSymbol, this.$$rxSignalThresholdFactor);
    this.$$txSampleRate = PhysicalLayer.DEFAULF_TX_SAMPLE_RATE;
    this.$$smartTimer = new SmartTimer(this.$$sampleTimeMs / 1000);
    this.$$smartTimer.setHandler(this.$$smartTimerHandler.bind(this));
};

PhysicalLayer.DEFAULF_TX_SAMPLE_RATE = 48000;

PhysicalLayer.prototype.txConnect = function (sampleRate) {
    var i, codeValue;

    this.$$txSampleRate = sampleRate;
    for (i = 0; i < this.$$connectSignalDetector.$$correlator.getCodeLength(); i++) {  // TODO refactor this
        codeValue = this.$$connectSignalDetector.$$correlator.getCodeValue(i);
        this.$$addToTxQueue(
            codeValue === -1 ? this.$$symbolSyncA : this.$$symbolSyncB
        );
    }
};

PhysicalLayer.prototype.txSymbol = function (symbol) {
    if (symbol) {
        this.$$addToTxQueue(symbol);
    }
};

PhysicalLayer.prototype.setLoopback = function (state) {
    this.$$audioMonoIO.setLoopback(state);
};

PhysicalLayer.prototype.getTxSampleRate = function () {
    return this.$$txSampleRate;
};

PhysicalLayer.prototype.getTxSymbolQueue = function () {
    return this.$$txSymbolQueue;
};

PhysicalLayer.prototype.setTxSampleRate = function (sampleRate) {
    this.$$txSampleRate = sampleRate;
};

PhysicalLayer.prototype.getState = function () {
    var state, cd;

    cd = this.$$connectSignalDetector.isConnected()
        ? this.$$connectSignalDetector.getConnectionDetail()
        : null;

    state = {
        dsp: {
            sampleRateReceive: this.$$audioMonoIO.getSampleRate(),
            sampleRateTransmit: this.$$txSampleRate,
            fftSize: this.$$fftSize,
            fftWindowTime: this.$$fftSize / this.$$audioMonoIO.getSampleRate(),
            fftFrequencyBinSkipFactor: this.$$fftFrequencyBinSkipFactor,
            symbolFrequencySpacing: this.$$fftFrequencyBinSkipFactor * this.$$audioMonoIO.getSampleRate() / this.$$fftSize,
            samplePerSymbol: this.$$samplePerSymbol
        },
        band: {
            frequencyData: this.$$frequencyDataReceiveBand,
            frequencyDataLoudestIndex: this.$$symbol - this.$$symbolMin,
            symbolMin: this.$$symbolMin,
            symbolMax: this.$$symbolMax,
            symbolRange: this.$$symbolMax - this.$$symbolMin + 1,
            frequencyMin: this.$$fftResult.getFrequency(this.$$symbolMin),
            frequencyMax: this.$$fftResult.getFrequency(this.$$symbolMax)
        },
        symbol: this.$$symbol,
        isSymbolSamplingPoint: this.$$isSymbolSamplingPoint,
        isSymbolReadyToTake: this.$$isSymbolReadyToTake,
        symbolDetail: {
            frequency: this.$$fftResult.getFrequency(this.$$symbol),
            signalDecibel: this.$$signalDecibel,
            noiseDecibel: this.$$noiseDecibel
        },
        offset: this.$$offset,
        sampleNumber: this.$$sampleNumber,
        isConnected: this.$$connectSignalDetector.isConnected(),
        isConnectionInProgress: this.$$connectSignalDetector.isConnectionInProgress(),
        connectionDetail: !cd ? null : {
            offset: cd.offset,
            correlationValue: cd.correlationValue,
            correlationValueMax: cd.correlationValueMax,
            signalDecibel: cd.signalDecibel,
            noiseDecibel: cd.noiseDecibel,
            signalToNoiseRatio: cd.signalToNoiseRatio,
            signalThresholdDecibel: cd.signalThresholdDecibel
        }
    };

    return state;
};

PhysicalLayer.$$isFunction = function (variable) {
    return typeof variable === 'function';
};

PhysicalLayer.$$getValueOrDefault = function (value, defaultValue) {
    return typeof value !== 'undefined' ? value : defaultValue;
};

PhysicalLayer.prototype.$$setTxSound = function () {
    var frequency;

    if (!this.$$txCurrentSymbol) {
        this.$$audioMonoIO.setPeriodicWave(undefined, 0);
        return;
    }

    frequency = (
        this.$$fftFrequencyBinSkipFactor *
        this.$$txCurrentSymbol *
        this.$$txSampleRate
    ) / this.$$fftSize;

    if (this.$$samplePerSymbol === 3) {
        switch (this.$$offset) {
            case 0:
                this.$$audioMonoIO.setPeriodicWave(frequency, 0);
                this.$$audioMonoIO.setPeriodicWaveFading(
                    this.$$txAmplitude,
                    (0.5 * this.$$sampleTimeMs) / 1000,
                    this.$$sampleTimeMs / 1000
                );
                // this.$$audioMonoIO.setPeriodicWave(frequency, 0.5 * this.$$txAmplitude);
                break;
            case 1:
                this.$$audioMonoIO.setPeriodicWave(frequency, this.$$txAmplitude);
                break;
            case 2:
                this.$$audioMonoIO.setPeriodicWaveFading(
                    0,
                    (0.5 * this.$$sampleTimeMs) / 1000,
                    this.$$sampleTimeMs / 1000
                );
                // this.$$audioMonoIO.setPeriodicWave(frequency, 0.5 * this.$$txAmplitude);
                break;
        }
    } else {
        this.$$audioMonoIO.setPeriodicWave(frequency, this.$$txAmplitude);
    }
};

PhysicalLayer.prototype.$$addToTxQueue = function (symbol) {
    this.$$txSymbolQueue.push(symbol);
};

PhysicalLayer.prototype.$$smartTimerHandler = function () {
    var state;

    this.$$offset = this.$$sampleNumber % this.$$samplePerSymbol;
    this.$$rxSmartTimerHandler();
    this.$$txSmartTimerHandler();
    state = this.getState();

    if (this.$$statusHandler) {
        this.$$statusHandler(state);
    }

    this.$$sampleNumber++;
};

PhysicalLayer.prototype.$$rxSmartTimerHandler = function () {
    var
        allowedToListenConnectSignal,
        dataLogicValue = null,
        frequencyData,
        connectionDetail,
        isSymbolAboveThreshold;

    frequencyData = this.$$audioMonoIO.getFrequencyData();
    this.$$fftResult = new FFTResult(frequencyData, this.$$audioMonoIO.getSampleRate());
    this.$$fftResult.downconvertScalar(this.$$fftFrequencyBinSkipFactor);
    this.$$symbol = this.$$fftResult.getLoudestBinIndexInBinRange(this.$$symbolMin, this.$$symbolMax);
    this.$$signalDecibel = this.$$fftResult.getDecibel(this.$$symbol);
    this.$$noiseDecibel = this.$$fftResult.getDecibelAverage(this.$$symbolMin, this.$$symbolMax, this.$$symbol);
    this.$$frequencyDataReceiveBand = this.$$fftResult.getDecibelRange(this.$$symbolMin, this.$$symbolMax);

    allowedToListenConnectSignal = !this.$$txCurrentSymbol || this.$$audioMonoIO.isLoopbackEnabled();
    if (allowedToListenConnectSignal) {
        switch (this.$$symbol) {
            case this.$$symbolSyncA:
                dataLogicValue = false;
                break;
            case this.$$symbolSyncB:
                dataLogicValue = true;
                break;
        }
    }
    this.$$connectSignalDetector.handle(this.$$sampleNumber, dataLogicValue, this.$$signalDecibel, this.$$noiseDecibel);

    connectionDetail = this.$$connectSignalDetector.getConnectionDetail();

    this.$$isSymbolSamplingPoint = this.$$connectSignalDetector.isConnected()
        ? (this.$$sampleNumber % this.$$samplePerSymbol) === connectionDetail.offset
        : false;

    isSymbolAboveThreshold = this.$$connectSignalDetector.isConnected()
        ? this.$$signalDecibel > connectionDetail.signalThresholdDecibel
        : false;

    this.$$isSymbolReadyToTake = this.$$isSymbolSamplingPoint && isSymbolAboveThreshold;
};

PhysicalLayer.prototype.$$txSmartTimerHandler = function () {
    var isFirstSampleOfBlock = this.$$offset === 0;

    if (isFirstSampleOfBlock) {
        this.$$txCurrentSymbol = this.$$txSymbolQueue.shift();
    }
    this.$$setTxSound();
};