// Official worship videos the catalog includes without a YouTube API key
// (the speedrun stand-in for the channel sync in AINOS-SPEC.md 3.2). The owner
// verifies each entry is the channel's own upload. Only the embed and
// YouTube's own title and thumbnail are used: never lyrics of a copyrighted
// song, never its audio.
//
// The generator (scripts/generate.js) writes, per video, a global song, a
// song_sources row, a youtube_video_cache row (refreshed by every deploy's
// catalog sync) and a search_index entry. Ids come from the video id, so
// appending a video never changes another row.

// When the curated rows were added. A fixed value, so a deploy's catalog sync
// does not rewrite the songs' timestamps.
export const YOUTUBE_ADDED = Date.UTC(2026, 9, 30);

export const YOUTUBE_VIDEOS = [
  {
    videoId: 'eov9K7ALYKk',
    title: 'Carry My Cross - Official Lyric Video', // YouTube's title, unmodified
    channelTitle: 'Victory Worship',
    channelHandle: '@victoryworshipph',
    kind: 'lyric', // 'official' | 'lyric' | 'live' | 'backing'
    songTitle: 'Carry My Cross',
    artist: 'Victory Worship',
    language: 'en',
  },
];

/** The thumbnail YouTube serves for every public video. */
export const thumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
