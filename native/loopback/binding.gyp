{
	"targets": [
		{
			"target_name": "aura_loopback",
			"sources": ["loopback.cc"],
			"include_dirs": ["../../node_modules/winplayer-node/node_modules/node-addon-api"],
			"defines": ["NAPI_VERSION=8", "NOMINMAX"],
			"msvs_settings": {
				"VCCLCompilerTool": {
					"ExceptionHandling": 1,
					"AdditionalOptions": ["/std:c++17"]
				}
			},
			"libraries": ["ole32.lib", "uuid.lib"]
		}
	]
}
