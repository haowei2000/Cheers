import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import toast from "react-hot-toast";
import { getDictationCapability, transcribeDictation } from "@/api/channels";

type SystemSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: {
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SystemSpeechRecognitionConstructor = new () => SystemSpeechRecognition;

interface StepFunCapture {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  sampleRate: number;
  channelId: string;
}

function systemSpeechRecognition(): SystemSpeechRecognitionConstructor | null {
  const browser = window as unknown as {
    SpeechRecognition?: SystemSpeechRecognitionConstructor;
    webkitSpeechRecognition?: SystemSpeechRecognitionConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

export function useComposerDictation({
  channelId,
  disabled,
  sending,
  uploading,
  setText,
  textareaRef,
  adjustHeight,
}: {
  channelId?: string;
  disabled?: boolean;
  sending: boolean;
  uploading: boolean;
  setText: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  adjustHeight: () => void;
}) {
  const dictationRecorderRef = useRef<MediaRecorder | null>(null);
  const dictationStreamRef = useRef<MediaStream | null>(null);
  const dictationChunksRef = useRef<Blob[]>([]);
  const discardDictationRef = useRef(false);
  const stepFunCaptureRef = useRef<StepFunCapture | null>(null);
  const systemRecognitionRef = useRef<SystemSpeechRecognition | null>(null);
  const [dictating, setDictating] = useState(false);
  const [transcribingDictation, setTranscribingDictation] = useState(false);

  function appendDictation(transcript: string) {
    const spoken = transcript.trim();
    if (!spoken) {
      toast("No speech was detected");
      return;
    }
    setText((draft) => (draft.trim() ? `${draft.trimEnd()} ${spoken}` : spoken));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      adjustHeight();
    });
  }

  function releaseDictationStream() {
    dictationStreamRef.current?.getTracks().forEach((track) => track.stop());
    dictationStreamRef.current = null;
  }

  function releaseStepFunCapture() {
    const capture = stepFunCaptureRef.current;
    stepFunCaptureRef.current = null;
    if (capture) {
      capture.processor.disconnect();
      capture.source.disconnect();
      void capture.context.close();
    }
    releaseDictationStream();
  }

  function pcm16leAt16k(capture: StepFunCapture): Blob {
    const sourceLength = capture.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const source = new Float32Array(sourceLength);
    let offset = 0;
    for (const chunk of capture.chunks) {
      source.set(chunk, offset);
      offset += chunk.length;
    }
    const ratio = capture.sampleRate / 16_000;
    const output = new Int16Array(Math.max(1, Math.floor(source.length / ratio)));
    for (let index = 0; index < output.length; index += 1) {
      const position = index * ratio;
      const before = Math.floor(position);
      const after = Math.min(before + 1, source.length - 1);
      const fraction = position - before;
      const sample = (source[before] ?? 0) * (1 - fraction) + (source[after] ?? 0) * fraction;
      output[index] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    }
    return new Blob([output.buffer as ArrayBuffer], { type: "audio/pcm" });
  }

  async function finishStepFunDictation(capture: StepFunCapture, targetChannelId: string) {
    stepFunCaptureRef.current = null;
    capture.processor.disconnect();
    capture.source.disconnect();
    void capture.context.close();
    releaseDictationStream();
    setDictating(false);
    if (!capture.chunks.length) {
      toast("No speech was detected");
      return;
    }
    setTranscribingDictation(true);
    try {
      const result = await transcribeDictation(targetChannelId, pcm16leAt16k(capture));
      appendDictation(result.transcript);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Dictation failed");
    } finally {
      setTranscribingDictation(false);
    }
  }

  function stopDictation(discard = false) {
    const recognition = systemRecognitionRef.current;
    if (recognition) {
      systemRecognitionRef.current = null;
      if (discard) recognition.abort();
      else recognition.stop();
    }
    const stepFunCapture = stepFunCaptureRef.current;
    if (stepFunCapture) {
      if (discard) {
        releaseStepFunCapture();
        setDictating(false);
      } else {
        void finishStepFunDictation(stepFunCapture, stepFunCapture.channelId);
      }
      return;
    }
    const recorder = dictationRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      if (discard) {
        discardDictationRef.current = true;
        dictationChunksRef.current = [];
      }
      recorder.stop();
    } else if (discard) {
      releaseDictationStream();
      setDictating(false);
    }
  }

  function startSystemDictation() {
    const Recognition = systemSpeechRecognition();
    if (!Recognition) {
      toast.error("No speech adapter is configured and this browser has no built-in dictation");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ");
      appendDictation(transcript);
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") {
        toast.error("System dictation failed — check microphone and speech permissions");
      }
    };
    recognition.onend = () => {
      if (systemRecognitionRef.current === recognition) {
        systemRecognitionRef.current = null;
        setDictating(false);
      }
    };
    systemRecognitionRef.current = recognition;
    setDictating(true);
    try {
      recognition.start();
    } catch {
      systemRecognitionRef.current = null;
      setDictating(false);
      toast.error("Couldn't start system dictation");
    }
  }

  async function startAdapterDictation() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("This browser cannot record audio for the configured speech adapter");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredType = "audio/webm;codecs=opus";
      const recorder = MediaRecorder.isTypeSupported(preferredType)
        ? new MediaRecorder(stream, { mimeType: preferredType })
        : new MediaRecorder(stream);
      dictationStreamRef.current = stream;
      dictationChunksRef.current = [];
      discardDictationRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) dictationChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = dictationChunksRef.current;
        const discard = discardDictationRef.current;
        dictationChunksRef.current = [];
        dictationRecorderRef.current = null;
        releaseDictationStream();
        setDictating(false);
        if (discard || !chunks.length) return;
        setTranscribingDictation(true);
        void transcribeDictation(channelId!, new Blob(chunks, { type: recorder.mimeType || "audio/webm" }))
          .then((result) => appendDictation(result.transcript))
          .catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : "Dictation failed"),
          )
          .finally(() => setTranscribingDictation(false));
      };
      recorder.onerror = () => toast.error("Dictation recording failed");
      dictationRecorderRef.current = recorder;
      recorder.start(1_000);
      setDictating(true);
    } catch {
      releaseDictationStream();
      toast.error("Couldn't access your microphone — check browser permission");
    }
  }

  async function startStepFunDictation() {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error("This browser cannot capture PCM audio for StepFun dictation");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor is supported by Chrome and Safari and lets us send the
      // exact PCM format required by StepFun without uploading a media file.
      const processor = context.createScriptProcessor(4096, 1, 1);
      const capture: StepFunCapture = {
        context,
        source,
        processor,
        chunks: [],
        sampleRate: context.sampleRate,
        channelId: channelId!,
      };
      processor.onaudioprocess = (event) => {
        capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(context.destination);
      dictationStreamRef.current = stream;
      stepFunCaptureRef.current = capture;
      await context.resume();
      setDictating(true);
    } catch {
      releaseStepFunCapture();
      toast.error("Couldn't access your microphone — check browser permission");
    }
  }

  async function startDictation() {
    if (!channelId || disabled || sending || uploading || dictating || transcribingDictation) return;
    try {
      const capability = await getDictationCapability(channelId);
      if (capability.adapter_kind === "stepfun") await startStepFunDictation();
      else if (capability.adapter_configured) await startAdapterDictation();
      else startSystemDictation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start dictation");
    }
  }

  const stopDictationRef = useRef(stopDictation);
  stopDictationRef.current = stopDictation;
  useEffect(
    () => () => stopDictationRef.current(true),
    [],
  );


  return {
    dictating,
    transcribingDictation,
    startDictation,
    stopDictation,
  };
}
