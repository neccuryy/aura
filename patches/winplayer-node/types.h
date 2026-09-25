#ifndef WINPLAYER_TYPES_H
#define WINPLAYER_TYPES_H

#include <cstddef>
#include <map>
#include <string>
#include <vector>

struct ArtData
{
	std::vector<uint8_t> data;
	std::vector<std::string> type;
};

struct Metadata
{
	std::string id;
	std::string title;
	std::string artist;
	std::vector<std::string> artists;
	std::string album;
	std::string albumArtist;
	std::vector<std::string> albumArtists;
	ArtData artData;
	float length;
};

struct Capabilities
{
	bool canControl;
	bool canPlayPause;
	bool canGoNext;
	bool canGoPrevious;
	bool canSeek;
};

struct Update
{
	std::optional<Metadata> metadata;
	Capabilities capabilities;
	std::string status;
	std::string loop;
	bool shuffle;
	float volume;
	float elapsed;
	// epoch-ms of the moment `elapsed` was captured — the JS side computes
	// the live position as elapsed + (now - elapsedAtMs); stamping at the
	// END of getUpdate (after metadata/artwork awaits) would make the
	// position lag behind by that whole await duration
	long long elapsedAtMs;
	std::string app;
	std::string appName;
};

#endif // WINPLAYER_TYPES_H
