// WASAPI loopback capture — the native half of the on-the-fly lyrics alignment.
// This addon does ONE thing: capture whatever Windows is rendering right now
// (default output device, shared mode) as float32 PCM and hand chunks to JS.
// All DSP (mid/side, bandpass, RMS, VAD) lives in TypeScript — keep the native
// surface as small as possible.
//
// Device-wide loopback for the spike; process-scoped loopback
// (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, Win10 20348+) comes later —
// it needs an AUMID→PID mapping from SMTC and a device-wide fallback anyway.

#define NOMINMAX
#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <ksmedia.h>

#include <atomic>
#include <thread>
#include <vector>
#include <string>
#include <cstdint>

namespace {

// one captured chunk handed to JS: interleaved float32 PCM + format info
struct Chunk {
	std::vector<uint8_t> pcm;
	uint32_t sampleRate = 0;
	uint16_t channels = 0;
	bool error = false;
	std::string message;
};

class Loopback : public Napi::ObjectWrap<Loopback> {
public:
	static Napi::Object Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(env, "Loopback", {
			InstanceMethod("start", &Loopback::Start),
			InstanceMethod("stop", &Loopback::Stop),
		});
		exports.Set("Loopback", func);
		return exports;
	}

	explicit Loopback(const Napi::CallbackInfo& info)
		: Napi::ObjectWrap<Loopback>(info) {}

	~Loopback() override {
		running.store(false);
		if (thread.joinable()) thread.join();
	}

private:
	Napi::Value Start(const Napi::CallbackInfo& info) {
		Napi::Env env = info.Env();
		if (running.load()) return env.Undefined();
		if (info.Length() < 1 || !info[0].IsFunction()) {
			Napi::TypeError::New(env, "start(callback) requires a function")
				.ThrowAsJavaScriptException();
			return env.Undefined();
		}
		tsfn = new Napi::ThreadSafeFunction(
			Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "aura-loopback", 0, 1));
		running.store(true);
		thread = std::thread(&Loopback::CaptureLoop, this);
		return env.Undefined();
	}

	Napi::Value Stop(const Napi::CallbackInfo& info) {
		Napi::Env env = info.Env();
		running.store(false);
		if (thread.joinable()) thread.join();
		if (tsfn) {
			// must Release or the TSFN keeps the Node event loop alive forever
			tsfn->Release();
			delete tsfn;
			tsfn = nullptr;
		}
		return env.Undefined();
	}

	void Emit(Chunk* chunk) {
		if (!tsfn) {
			delete chunk;
			return;
		}
		auto callback = [](Napi::Env env, Napi::Function jsCallback, Chunk* c) {
			Napi::HandleScope scope(env);
			if (c->error) {
				auto err = Napi::Error::New(env, c->message);
				jsCallback.Call({err.Value()});
			} else {
				auto obj = Napi::Object::New(env);
				obj.Set("sampleRate", c->sampleRate);
				obj.Set("channels", c->channels);
				obj.Set(
					"data",
					Napi::Buffer<uint8_t>::Copy(env, c->pcm.data(), c->pcm.size()));
				jsCallback.Call({obj});
			}
			delete c;
		};
		tsfn->BlockingCall(chunk, callback);
	}

	void Fail(const std::string& message) {
		auto* chunk = new Chunk();
		chunk->error = true;
		chunk->message = message;
		Emit(chunk);
	}

	void CaptureLoop() {
		HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
			Fail("CoInitializeEx failed: " + std::to_string(hr));
			return;
		}

		IMMDeviceEnumerator* enumerator = nullptr;
		IMMDevice* device = nullptr;
		IAudioClient* client = nullptr;
		IAudioCaptureClient* capture = nullptr;
		WAVEFORMATEX* fmt = nullptr;

		auto cleanup = [&]() {
			if (capture) capture->Release();
			if (client) client->Release();
			if (device) device->Release();
			if (enumerator) enumerator->Release();
			if (fmt) CoTaskMemFree(fmt);
			CoUninitialize();
		};

		hr = CoCreateInstance(
			__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
			__uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
		if (FAILED(hr)) {
			Fail("CoCreateInstance(MMDeviceEnumerator) failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
		if (FAILED(hr)) {
			Fail("GetDefaultAudioEndpoint failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
			reinterpret_cast<void**>(&client));
		if (FAILED(hr)) {
			Fail("Activate(IAudioClient) failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		hr = client->GetMixFormat(&fmt);
		if (FAILED(hr)) {
			Fail("GetMixFormat failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		// the shared-mode engine mix format is float32 in practice; anything
		// else would need conversion — refuse instead of guessing
		bool isFloat32 = false;
		if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT && fmt->wBitsPerSample == 32) {
			isFloat32 = true;
		} else if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt->wBitsPerSample == 32) {
			auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
			isFloat32 = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
		}
		if (!isFloat32) {
			Fail("unexpected mix format (not float32)");
			cleanup();
			return;
		}

		// 1-second buffer; loopback ignores the event-driven mode, so the
		// loop below polls — 50ms sleep keeps latency and CPU negligible
		hr = client->Initialize(
			AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
			10000000, 0, fmt, nullptr);
		if (FAILED(hr)) {
			Fail("Initialize(loopback) failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		hr = client->Start();
		if (FAILED(hr)) {
			Fail("Start failed: " + std::to_string(hr));
			cleanup();
			return;
		}

		hr = client->GetService(__uuidof(IAudioCaptureClient),
			reinterpret_cast<void**>(&capture));
		if (FAILED(hr)) {
			Fail("GetService(IAudioCaptureClient) failed: " + std::to_string(hr));
			client->Stop();
			cleanup();
			return;
		}

		const uint32_t rate = fmt->nSamplesPerSec;
		const uint16_t channels = fmt->nChannels;
		const size_t blockAlign = fmt->nBlockAlign;

		while (running.load()) {
			Sleep(50);

			// packet-based reads from the capture client; loopback delivers
			// whatever the device rendered since the last drain
			UINT32 packetFrames = 0;
			while (SUCCEEDED(capture->GetNextPacketSize(&packetFrames)) &&
				packetFrames > 0) {
				BYTE* data = nullptr;
				UINT32 frames = 0;
				DWORD flags = 0;
				if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr)))
					break;

				auto* chunk = new Chunk();
				chunk->sampleRate = rate;
				chunk->channels = channels;
				if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
					// device had nothing to render — emit zeros so JS keeps a
					// continuous timeline
					chunk->pcm.assign(static_cast<size_t>(frames) * blockAlign, 0);
				} else {
					chunk->pcm.assign(
						data, data + static_cast<size_t>(frames) * blockAlign);
				}
				capture->ReleaseBuffer(frames);
				Emit(chunk);
			}
		}

		client->Stop();
		cleanup();
	}

	std::atomic<bool> running{false};
	std::thread thread;
	Napi::ThreadSafeFunction* tsfn = nullptr;
};

} // namespace

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
	return Loopback::Init(env, exports);
}

NODE_API_MODULE(aura_loopback, InitModule)
