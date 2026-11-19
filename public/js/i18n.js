// UI text and song-language metadata for Ainos (Christian Worship & Praise).
// The interface is English only (owner, 2026-11-19). Songs come in English (en)
// and Nepali (ne): the listener's song language picks what is recommended and
// which lyrics show first. It never changes the interface text.

export const SONG_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'ne', label: 'Nepali', native: 'नेपाली' },
];

export const SONG_LANGUAGE_CODES = SONG_LANGUAGES.map((l) => l.code);

/** The interface's one locale, for dates and numbers too. */
export const UI_LOCALE = 'en';

export const STRINGS = {
  en: {
    brandSubtitle: 'Worship & Praise',
    faithBanner: 'Songs of worship and praise to God, in every tongue',
    // Login
    loginTitle: 'Log in to Ainos',
    signupTitle: 'Sign up for Ainos',
    username: 'Username',
    displayName: 'Display name',
    password: 'Password',
    loginBtn: 'Log in',
    signupBtn: 'Create account',
    demoBtn: 'Try the demo',
    demoHint: 'No sign-up needed. The demo account is shared and resets each time someone starts it.',
    orDivider: 'or',
    demoBanner: 'You’re in the shared demo. Anything you change resets when the next visitor starts it.',
    demoBannerAction: 'Sign up to keep your playlists',
    errBadCredentials: 'Wrong username or password.',
    errUsernameTaken: 'That username is taken. Try another one.',
    errBadUsername: 'Usernames are 3–32 characters: letters, numbers, _ . or -',
    errBadPassword: 'Passwords need at least 8 characters.',
    errRateLimited: 'Too many tries. Wait a minute, then try again.',
    errNetwork: 'Could not reach Ainos. Check your connection and try again.',
    errOffline: 'You are offline. Reconnect and try again.',
    errTimeout: 'Ainos is taking too long to answer. Try again in a moment.',
    errServer: 'Something went wrong on our side. Try again in a moment.',
    errDemoPrivate: 'Demo playlists stay private. Sign up to share a playlist.',
    errDemoNotAllowed: 'The shared demo can’t do this. Sign up to use it.',
    tryAgain: 'Try again',
    playTitle: 'Play {title}',
    moreOptions: 'More options',
    moreOptionsFor: 'More options for {title}',
    downloadingToast: 'Downloading {n} songs…',
    downloadedNToast: 'Downloaded {n} songs for offline listening',
    deviceNameSaved: 'Device name saved. Reload to use it.',
    cacheCleared: 'Cache cleared',
    searchContext: 'Search “{q}”',
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} hr ago',
    yesterday: 'yesterday',
    daysAgo: '{n} days ago',
    cantPlay: 'Can’t play “{title}”. Try another song.',
    playbackFailed: 'Playback stopped. Press play to try again.',
    playbackSkipping: 'This song wouldn’t play, so Ainos skipped it.',
    skipToContent: 'Skip to content',
    loadingApp: 'Loading Ainos…',
    moveUp: 'Move up',
    moveDown: 'Move down',
    timeOf: '{cur} of {dur}',
    emptyStatsTitle: 'Your worship year starts here',
    emptyStatsSub: 'Play a few songs for at least 30 seconds each and your minutes, top songs and favourite times will show up here.',
    browseMusic: 'Find something to play',
    emptyLibraryHint: 'Playlists you make and artists you follow will show up here.',
    pickSongHint: 'Pick a song to start listening',
    noAccount: 'Don’t have an account?',
    hasAccount: 'Already have an account?',
    signupLink: 'Sign up',
    loginLink: 'Log in',
    // Nav
    navHome: 'Home',
    navSearch: 'Search',
    navLibrary: 'Your Library',
    navLibraryShort: 'Library',
    navInternals: 'Under the hood',
    navInternalsShort: 'Internals',
    createPlaylist: 'Create playlist',
    goBack: 'Go back',
    goForward: 'Go forward',
    searchPlaceholder: 'Search songs, artists or albums…',
    languageLabel: 'Song language',
    accountLabel: 'Account',
    // Player
    shuffle: 'Shuffle',
    previous: 'Previous',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    repeat: 'Repeat',
    nowPlayingView: 'Now playing view',
    queue: 'Queue',
    connectDevice: 'Connect to a device',
    mute: 'Mute',
    volume: 'Volume',
    playingOn: 'Playing on {device}',
    // Greetings
    goodNight: 'Peaceful night in worship',
    goodMorning: 'Good morning — praise & devotion',
    goodAfternoon: 'Good afternoon in praise',
    goodEvening: 'Good evening — time for worship',
    // Home sections
    recommendedInLang: 'Recommended {lang} songs',
    recommendedInLangSub: 'Worship & praise songs in {lang}, tailored to your listening',
    madeForYou: 'Worship Mixes for {name}',
    madeForYouSub: 'Made from what you listen to',
    recentlyPlayed: 'Recently played',
    popularNow: 'Popular worship right now ({lang})',
    popularNowSub: 'Most played in {lang} this week',
    newReleases: 'New releases',
    ainosPicks: 'Ainos Devotional Picks',
    ainosPicksSub: 'Curated from worship audio features for prayer, focus and praise',
    suggestedArtists: 'Worship artists you might like',
    // Common labels
    likedSongs: 'Liked Songs',
    downloaded: 'Downloaded',
    playlist: 'Playlist',
    publicPlaylist: 'Public playlist',
    privatePlaylist: 'Private playlist',
    ainosPlaylist: 'Ainos worship playlist',
    artist: 'Artist',
    artists: 'Artists',
    album: 'Album',
    albums: 'Albums',
    single: 'Single',
    song: 'Song',
    songs: 'Songs',
    songsCount: '{n} songs',
    tracksCount: '{n} tracks',
    artistsCount: '{n} artists',
    plays7Days: 'Plays (7 days)',
    plays: 'Plays',
    streams: 'Streams',
    titleCol: 'Title',
    albumCol: 'Album',
    durationCol: 'Duration',
    dateAdded: 'Date added',
    playedCol: 'Played',
    sizeCol: 'Size',
    similarityCol: 'Similarity',
    seed: 'seed',
    // Search
    browseAll: 'Browse worship styles',
    noResultsTitle: 'No results found for “{q}”',
    noResultsSub: 'Check the spelling, or try fewer or different keywords.',
    topResult: 'Top result',
    noSongs: 'No songs',
    byOwner: 'By {name}',
    // Library
    filterAll: 'All',
    filterPlaylists: 'Playlists',
    filterArtists: 'Artists',
    // Artist / Album / Playlist / Mix / Radio
    monthlyListeners: '{n} monthly listeners',
    follow: 'Follow',
    following: 'Following',
    popular: 'Popular',
    discography: 'Discography',
    about: 'About',
    fansAlsoLike: 'Fellow believers also like',
    fansAlsoLikeSub: 'From co-listening patterns + audio similarity',
    releasedDate: 'Released {date}',
    synthesizedNote: '℗ {year} {artist} · Synthesized for Ainos',
    editDetails: 'Edit details',
    nameField: 'Name',
    descField: 'Description',
    save: 'Save',
    cancel: 'Cancel',
    makePrivate: 'Make private',
    makePublic: 'Make public',
    deletePlaylist: 'Delete',
    emptyPlaylistTitle: 'This worship playlist is empty',
    emptyPlaylistSub: 'Add songs with the ••• menu on any track, or pick from the recommendations below.',
    dragTip: 'Tip: drag rows to reorder, or use ⋯ › Move up / Move down.',
    recommended: 'Recommended songs',
    recommendedSub: 'Based on what’s in this playlist',
    addBtn: 'Add',
    madeForYouKind: 'Made for you',
    howMadeNote: 'How this was made: weighted matrix factorization (implicit ALS) over listeners’ streams and likes, blended with audio-feature similarity and your chosen language.',
    radioKind: 'Worship Radio',
    radioTitle: '{title} Radio',
    radioDesc: 'Songs similar to {title} by {artist}, from listening patterns and audio features.',
    emptyLikedTitle: 'Songs you like will appear here',
    emptyLikedSub: 'Save worship songs by tapping the heart icon.',
    genreKind: 'Worship Style',
    emptyRecentTitle: 'Nothing yet',
    emptyRecentSub: 'Play a song and it will show up here.',
    emptyDownloadsTitle: 'No downloads yet',
    emptyDownloadsSub: 'Use the download button on an album or playlist. Downloaded worship music plays even when offline.',
    downloadsInfo: '{count} tracks · {bytes} stored for offline. Streaming cache: {lruFiles} tracks, {lruBytes} of {lruLimit}.',
    // Stats
    statsTitle: '{name}’s year in worship',
    statsSub: 'Computed from your stream history (plays of 30 seconds or more). Shorter plays count as skips.',
    minutesListened: 'minutes in worship',
    streamsLabel: 'streams',
    shortPlays: 'plays under 30 s (not counted)',
    topGenre: 'top worship style',
    topSongs: 'Top songs',
    topArtists: 'Top worship artists',
    genresTitle: 'Worship styles',
    whenYouListen: 'When you worship',
    // Settings
    settingsTitle: 'Settings',
    accountSection: 'Account',
    planDescription: 'All-Access plan: high-quality lossless-grade PCM audio (353 kbps), unlimited skips, offline downloads & multi-device Connect.',
    planBadge: 'All-Access',
    planMechanism: 'All-Access Plan',
    planHow: 'Single unified plan: High quality (353 kbps), unlimited skips, offline downloads & multi-device Connect',
    planEvidence: 'Every feature included for every listener',
    cantReachAinos: 'Can’t reach Ainos',
    remoteCommandFailed: 'Remote command failed',
    offlineToast: 'You’re offline. Downloaded music still plays.',
    onlineToast: 'Back online',
    pageNotFound: 'Page not found',
    somethingWentWrong: 'Something went wrong',
    goHome: 'Go home',
    closePanel: 'Close panel',
    queueLivesOn: 'The queue lives on {device}. Use “Add to queue” here and it is sent there.',
    removeFromQueueLabel: 'Remove {title} from queue',
    languageSettingTitle: 'Song language',
    languageSettingDesc: 'Recommends songs in this language and shows their lyrics first. The app itself stays in English.',
    audioSection: 'Audio',
    streamingQuality: 'Streaming quality',
    streamingQualityDesc: 'Automatic picks Low on slow or data-saver connections. High (353 kbps) is always unlocked.',
    qualityAuto: 'Automatic',
    qualityLow: 'Low (176 kbps)',
    qualityHigh: 'High (353 kbps)',
    normalizeVolume: 'Normalize volume',
    normalizeVolumeDesc: 'Set the same loudness level for all worship songs.',
    volumeLevel: 'Volume level',
    volumeLevelDesc: 'Loud −11 LUFS, Normal −14 LUFS, Quiet −19 LUFS.',
    loudnessLoud: 'Loud',
    loudnessNormal: 'Normal',
    loudnessQuiet: 'Quiet',
    cachePlayed: 'Cache played songs',
    cachePlayedDesc: 'Keep fully played songs in a 60 MB cache so replays don’t hit the network.',
    crossfadeTitle: 'Crossfade',
    crossfadeDesc: 'Blend the end of each song into the next one. Works when a song plays to its end.',
    crossfadeOff: 'Off',
    secondsN: '{n} s',
    on: 'On',
    off: 'Off',
    devicesStorageSection: 'Devices & storage',
    deviceNameTitle: 'This device’s name',
    deviceNameDesc: 'Shown in the Connect device list on your other devices.',
    streamingCacheTitle: 'Streaming cache',
    streamingCacheDesc: '{files} tracks, {bytes} used. Downloads ({offline}) are kept.',
    clearCache: 'Clear cache',
    logoutTitle: 'Log out',
    logoutDesc: 'Ends this session on this browser.',
    // Menus & Right panel
    addToQueue: 'Add to queue',
    goToRadio: 'Go to song radio',
    goToArtist: 'Go to artist',
    goToAlbum: 'Go to album',
    addToPlaylist: 'Add to playlist',
    newPlaylist: 'New playlist',
    removeFromLiked: 'Remove from your Liked Songs',
    saveToLiked: 'Save to your Liked Songs',
    removeFromPlaylist: 'Remove from this playlist',
    removeDownload: 'Remove download',
    download: 'Download',
    startRadio: 'Start radio',
    yourStats: 'Your stats',
    howItWorks: 'How the streaming engine works',
    thisBrowser: 'This browser',
    playing: 'Playing',
    active: 'Active',
    tapToPlay: 'Tap to play here',
    connecting: 'Connecting…',
    tryIt: 'Try it',
    connectHelp: 'Open Ainos in another tab, browser or phone and log in with the same account. Pick a device to move worship playback there, or control the active device from any other.',
    nothingPlaying: 'Nothing playing.',
    nowPlaying: 'Now playing',
    nextInQueue: 'Next in queue',
    nextFrom: 'Next from: {title}',
    nothingAfter: 'Nothing after this one. Turn on repeat or add songs to the queue.',
    repeatIsOn: 'Repeat is on.',
    pickSomething: 'Pick a song to play. Details about the stream, its loudness and audio features show up here.',
    playingFrom: 'Playing from ',
    streamCard: 'Stream',
    qualityLabel: 'Quality',
    loudnessLabel: 'Loudness',
    startLatencyLabel: 'Start latency',
    sourceLabel: 'Source',
    nextTrackLabel: 'Next track',
    countsAsStreamLabel: 'Counts as a stream',
    audioFeaturesCard: 'Audio features',
    energy: 'Energy',
    danceability: 'Danceability',
    valence: 'Valence',
    acousticness: 'Acousticness',
    aboutArtistCard: 'About the artist',
    scriptureCard: 'Scripture',
    verseOfTheDay: 'Verse of the Day',
    bibleVersionTitle: 'Bible version',
    bibleVersionDesc: 'The translation Scripture passages are shown in',
    bibleVersionAuto: 'Automatic',
    scriptureNoText: 'This passage isn’t available in this Bible version yet.',
    scriptureUnavailable: 'Scripture couldn’t be loaded right now.',
    songDetails: 'Song details',
    songLabel: 'Song',
    recordingsTitle: 'Recordings',
    publicDomainSong: 'Public domain',
    // Toasts
    addedToLiked: 'Added to Liked Songs',
    removedFromLiked: 'Removed from Liked Songs',
    addedToQueueToast: 'Added to queue',
    createdPlaylistToast: 'Created “{name}”',
    addedToPlaylistToast: 'Added to {name}',
    removedFromLibraryToast: 'Removed from Your Library',
    downloadedToast: 'Downloaded',
    downloadRemovedToast: 'Download removed',
    languageChangedToast: 'Song language set to {lang}',
    // Language names
    lang_en: 'English',
    lang_ne: 'Nepali',
    // Translated mix / editorial titles
    mix_discover_weekly: 'Discover Weekly',
    mix_discover_weekly_desc: 'Your weekly mix of fresh worship in {lang}. Refreshes every Monday.',
    mix_on_repeat: 'On Repeat',
    mix_on_repeat_desc: 'The worship songs you can’t stop playing right now.',
    mix_daily: 'Daily Worship Mix {n}',
    mix_daily_desc: '{genre} and more in {lang}, based on what you play.',
  },





};

const EDITORIAL_I18N = {
  'Deep Focus': {
    en: ['Deep Prayer & Focus', 'Low-energy contemplative instrumentals for Scripture reading and prayer.'],
  },
  'Energy Boost': {
    en: ['Joyful Praise', 'High-energy praise celebrating faith and victory.'],
  },
  'Dance Floor': {
    en: ['Youth Worship Celebration', 'Rhythmic, uplifting songs for youth fellowship and celebration.'],
  },
  'Feel Good': {
    en: ['Grace & Gratitude', 'Bright, major-key melodies filled with hope and thanksgiving.'],
  },
  'Night Drive': {
    en: ['Evening Vespers', 'Reflective minor keys and steady tempos for night prayer and peace.'],
  },
  'Acoustic Mornings': {
    en: ['Morning Devotional', 'Gentle acoustic hymns and strings to begin your day with God.'],
  },
  Hymns: {
    en: ['Hymns', 'Public-domain hymns, played as written, with their words to sing along.'],
  },
};

const GENRE_I18N = {
  Ambient: { en: 'Ambient Worship' },
  Synthwave: { en: 'Synth Praise' },
  'Lo-fi': { en: 'Devotional Lo-fi' },
  House: { en: 'Praise House' },
  Acoustic: { en: 'Acoustic Worship' },
  Chiptune: { en: 'Chiptune Praise' },
  Dub: { en: 'Psalms & Dub' },
  'Drum & Bass': { en: 'Rhythmic Praise' },
  Hymn: { en: 'Hymns' },
};

let songLang = 'en';
try {
  const saved = localStorage.getItem('ainos.songLang');
  if (saved && SONG_LANGUAGE_CODES.includes(saved)) songLang = saved;
} catch { /* ignore */ }

// Feature string modules (Phases 3-6) merge into STRINGS, one file per feature.
import listenerStrings from './strings/listener.js';
import churchStrings from './strings/church.js';
import presentStrings from './strings/present.js';
for (const part of [listenerStrings, churchStrings, presentStrings]) Object.assign(STRINGS.en, part.en);

/** The language songs are recommended in ('en' or 'ne'). */
export function getSongLang() {
  return songLang;
}

export function setSongLang(lang) {
  if (!SONG_LANGUAGE_CODES.includes(lang)) return songLang;
  songLang = lang;
  try { localStorage.setItem('ainos.songLang', lang); } catch { /* ignore */ }
  return songLang;
}

export function t(key, vars = {}) {
  const raw = STRINGS.en[key] ?? key;
  return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

const ERROR_KEYS = {
  bad_credentials: 'errBadCredentials', username_taken: 'errUsernameTaken', bad_username: 'errBadUsername', bad_password: 'errBadPassword',
  rate_limited: 'errRateLimited', network: 'errNetwork', offline: 'errOffline', timeout: 'errTimeout', server: 'errServer', demo_private: 'errDemoPrivate',
  demo_not_allowed: 'errDemoNotAllowed', forbidden_role: 'errForbiddenRole', last_admin: 'errLastAdmin', invite_invalid: 'errInviteInvalid',
};

/** A message for an API error (the server's text when the code has no message of its own). */
export function errorText(err) {
  const key = ERROR_KEYS[err?.code] || (err?.status >= 500 ? 'errServer' : err?.status === 429 ? 'errRateLimited' : null);
  return key ? t(key) : err?.message || t('errServer');
}

const SECTION_KEYS = { C: 'sectionChorus', C2: 'sectionChorus2', PC: 'sectionPreChorus', B: 'sectionBridge', T: 'sectionTag', I: 'sectionIntro', E: 'sectionEnding' };

/** A lyric section label as shown everywhere (lyrics view, church dashboard, slides): 'V2' → "Verse 2", 'C' → "Chorus". */
export function sectionName(label) {
  const l = label == null ? '' : String(label);
  const v = /^V(\d+)$/.exec(l);
  if (v) return t('sectionVerse', { n: new Intl.NumberFormat(UI_LOCALE).format(Number(v[1])) });
  return SECTION_KEYS[l] ? t(SECTION_KEYS[l]) : l;
}

/** A song language's name, e.g. 'ne' → "Nepali". */
export function langDisplayName(code) {
  return t(`lang_${code}`);
}

export function translateEditorial(playlist) {
  // Only editorial playlists get their Ainos names; a user's own playlist that happens
  // to be called "Deep Focus" keeps its name.
  if (!playlist || playlist.editorial === false) return playlist;
  const entry = EDITORIAL_I18N[playlist.name];
  if (!entry) return playlist;
  const [name, description] = entry.en;
  return { ...playlist, name, description };
}

export function translateMix(mix, langCode = songLang) {
  if (!mix) return mix;
  const langName = langDisplayName(langCode);
  if (mix.kind === 'discover-weekly') {
    return { ...mix, title: t('mix_discover_weekly'), description: t('mix_discover_weekly_desc', { lang: langName }) };
  }
  if (mix.kind === 'on-repeat') {
    return { ...mix, title: t('mix_on_repeat'), description: t('mix_on_repeat_desc') };
  }
  const m = /^daily-mix-(\d)$/.exec(mix.kind || '');
  if (m) {
    // Server description is "<Genre> and more, …"; genres can contain spaces ("Drum & Bass").
    const desc = mix.description || '';
    const genreKey = Object.keys(GENRE_I18N).find((g) => desc.startsWith(`${g} `)) ?? (/^(.+?) and more\b/.exec(desc)?.[1] || '');
    const genre = translateGenre(genreKey);
    return { ...mix, title: t('mix_daily', { n: m[1] }), description: t('mix_daily_desc', { genre, lang: langName }) };
  }
  return mix;
}

export function translateGenre(genre) {
  const g = GENRE_I18N[genre];
  if (!g) return genre;
  return g.en || genre;
}
