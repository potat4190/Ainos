// Display names for the generated catalog (AINOS-SPEC.md Phase 1.2).
//
// DRAFT FOR THE OWNER'S APPROVAL. Nothing uses these names until the owner
// picks them, and they are not deployed before that.
//
// The keys are the names written in CATALOG (scripts/generate.js), as
// "<artist>", "<artist>/<album>" or "<artist>/<track>". Those stay in
// generate.js for good: track ids come from the order of the catalog, and
// each track's audio, tempo, key and features are drawn from its key
// (test/catalog-ids.test.js checks this). Only the name people see changes.
//
// How to choose: set `pick` to 'a' or 'b', or put your own name in `custom`.
// Each option is [name, Scripture it draws on (USFM)]. For the artists who
// sing in Hindi, Chinese, Japanese, Nepali and Spanish, option a is in that
// language and option b is English; translations need a native speaker's
// check (docs/i18n-review.md).
//
// The artist names were searched on 2026-10-29 and match no worship act
// found (one near miss, "Lamplight", is an unrelated alt-folk project).
// Track titles quote or paraphrase Scripture and avoid well-known modern
// worship song titles (test/catalog-names.test.js keeps a list).

export const ARTISTS = {
  'Lumen Drift': { pick: null, custom: null, a: ['Lamplight Hours', 'PSA.119.105'], b: ['Cedar & Dawn', 'PSA.92.12'] },
  'Neon Harbor': { pick: null, custom: null, a: ['Lanternfall', 'JHN.1.5'], b: ['Second Watch Signal', 'LUK.12.38'] },
  'Copper Fox': { pick: null, custom: null, a: ['दीपक धुन', 'PSA.119.105'], b: ['Monsoon Lamp', 'PSA.119.105'] }, // "Deepak Dhun": lamp melody
  'Velvet Static': { pick: null, custom: null, a: ['麦田之光', 'JHN.4.35'], b: ['Harvest Lights', 'JHN.4.35'] }, // "light of the wheat fields"
  'Juniper Lane': { pick: null, custom: null, a: ['Hollow Pine Hymnworks', 'ISA.41.19'], b: ['Wren & Wheat', 'MAT.10.29'] },
  'Kite Theory': { pick: null, custom: null, a: ['ひかりの子ら', 'EPH.5.8'], b: ['Hikari Arcade', 'EPH.5.8'] }, // "children of light"
  'Ossa': { pick: null, custom: null, a: ['शान्त जल', 'PSA.23.2'], b: ['Still Water Sound', 'PSA.23.2'] }, // "Shanta Jal": still water
  'Polar Bloom': { pick: null, custom: null, a: ['Diez Lámparas', 'MAT.25.1'], b: ['Cántaro y Luz', 'JDG.7.20'] }, // "ten lamps"; "jar and light"
};

export const ALBUMS = {
  'Lumen Drift/Slow Light': { pick: null, custom: null, a: ['Morning by Morning', 'LAM.3.23'], b: ['A Lamp for My Feet', 'PSA.119.105'] },
  'Neon Harbor/Night Transit': { pick: null, custom: null, a: ['Watchmen for the Morning', 'PSA.130.6'], b: ['The Night Is Far Spent', 'ROM.13.12'] },
  'Neon Harbor/Overdrive': { pick: null, custom: null, a: ['Run the Race', 'HEB.12.1'], b: ['Wings Like Eagles', 'ISA.40.31'] }, // single: same as its track
  'Copper Fox/Rainy Window Tapes': { pick: null, custom: null, a: ['आशीष की वर्षा', 'EZK.34.26'], b: ['Showers of Blessing', 'EZK.34.26'] },
  'Copper Fox/Paper Moon': { pick: null, custom: null, a: ['चाँद और तारे', 'PSA.8.3'], b: ['The Work of Your Fingers', 'PSA.8.3'] }, // single
  'Velvet Static/Floor Theory': { pick: null, custom: null, a: ['在祂面前跳舞', '2SA.6.14'], b: ['Dance Before the Lord', '2SA.6.14'] },
  'Velvet Static/Sunrise Set': { pick: null, custom: null, a: ['公义的日头', 'MAL.4.2'], b: ['Sun of Righteousness', 'MAL.4.2'] }, // single
  'Juniper Lane/Wooden Rooms': { pick: null, custom: null, a: ['Consider the Lilies', 'MAT.6.28'], b: ['The Carpenter’s Bench', 'MRK.6.3'] },
  'Kite Theory/Pixel Weather': { pick: null, custom: null, a: ['空の鳥を見よ', 'MAT.6.26'], b: ['Birds of the Air', 'MAT.6.26'] },
  'Ossa/Low Tide': { pick: null, custom: null, a: ['गहिराइबाट', 'PSA.130.1'], b: ['Out of the Depths', 'PSA.130.1'] },
  'Polar Bloom/Ice Engine': { pick: null, custom: null, a: ['Más Blanco que la Nieve', 'PSA.51.7'], b: ['Whiter Than Snow', 'PSA.51.7'] },
};

export const TRACKS = {
  // Lumen Drift — contemplative ambient
  'Lumen Drift/First Glow': { pick: null, custom: null, a: ['Morning Star', 'REV.22.16'], b: ['Before the Dawn', 'PSA.119.147'] },
  'Lumen Drift/Glass Horizon': { pick: null, custom: null, a: ['Sea of Glass', 'REV.4.6'], b: ['Beside Still Waters', 'PSA.23.2'] },
  'Lumen Drift/Tidal Memory': { pick: null, custom: null, a: ['Deep Calls to Deep', 'PSA.42.7'], b: ['Waves and Billows', 'PSA.42.7'] },
  'Lumen Drift/Afterlight': { pick: null, custom: null, a: ['Light in the Darkness', 'JHN.1.5'], b: ['Evening and Morning', 'PSA.55.17'] },
  // Neon Harbor — light overcoming darkness
  'Neon Harbor/Midnight Arcade': { pick: null, custom: null, a: ['Songs at Midnight', 'ACT.16.25'], b: ['The Prison Doors Opened', 'ACT.16.26'] },
  'Neon Harbor/Chrome Avenue': { pick: null, custom: null, a: ['Streets of Gold', 'REV.21.21'], b: ['The Narrow Way', 'MAT.7.14'] },
  'Neon Harbor/Lost Signal': { pick: null, custom: null, a: ['The Lost Sheep', 'LUK.15.4'], b: ['Found Again', 'LUK.15.24'] },
  'Neon Harbor/Sunset Protocol': { pick: null, custom: null, a: ['From the Rising of the Sun', 'PSA.113.3'], b: ['Evening Sacrifice', 'PSA.141.2'] },
  'Neon Harbor/Overdrive': { pick: null, custom: null, a: ['Run the Race', 'HEB.12.1'], b: ['Wings Like Eagles', 'ISA.40.31'] },
  // Copper Fox — Hindi devotional (a: Hindi, b: English)
  'Copper Fox/Steam & Paper': { pick: null, custom: null, a: ['रोज़ की रोटी', 'MAT.6.11'], b: ['Daily Bread', 'MAT.6.11'] }, // "daily bread"
  'Copper Fox/Corner Café': { pick: null, custom: null, a: ['कुएँ पर', 'JHN.4.6'], b: ['Living Water', 'JHN.4.10'] }, // "at the well"
  'Copper Fox/Sunday Static': { pick: null, custom: null, a: ['विश्राम का दिन', 'HEB.4.9'], b: ['Sabbath Rest', 'HEB.4.9'] }, // "day of rest"
  'Copper Fox/Late Bus Home': { pick: null, custom: null, a: ['घर वापसी', 'LUK.15.20'], b: ['The Long Road Home', 'LUK.15.20'] }, // "homecoming"
  'Copper Fox/Paper Moon': { pick: null, custom: null, a: ['चाँद और तारे', 'PSA.8.3'], b: ['The Work of Your Fingers', 'PSA.8.3'] }, // "moon and stars"
  // Velvet Static — Chinese youth praise (a: Chinese, b: English)
  'Velvet Static/Pulse Garden': { pick: null, custom: null, a: ['新造的人', '2CO.5.17'], b: ['New Creation', '2CO.5.17'] },
  'Velvet Static/Mirrorball Heart': { pick: null, custom: null, a: ['清心的人', 'MAT.5.8'], b: ['Pure in Heart', 'MAT.5.8'] },
  'Velvet Static/Deep Current': { pick: null, custom: null, a: ['生命河', 'REV.22.1'], b: ['River of Life', 'REV.22.1'] },
  'Velvet Static/Open Air': { pick: null, custom: null, a: ['风随着意思吹', 'JHN.3.8'], b: ['Wind of the Spirit', 'JHN.3.8'] }, // "the wind blows where it wills"
  'Velvet Static/Sunrise Set': { pick: null, custom: null, a: ['公义的日头', 'MAL.4.2'], b: ['Sun of Righteousness', 'MAL.4.2'] },
  // Juniper Lane — acoustic, folk
  'Juniper Lane/Porch Song': { pick: null, custom: null, a: ['I Stand at the Door', 'REV.3.20'], b: ['Supper with Friends', 'REV.3.20'] },
  'Juniper Lane/Willow & Wire': { pick: null, custom: null, a: ['Harps on the Willows', 'PSA.137.2'], b: ['By the Rivers', 'PSA.137.1'] },
  'Juniper Lane/Little Lantern': { pick: null, custom: null, a: ['A Lamp on a Stand', 'MAT.5.15'], b: ['Let Your Light Shine', 'MAT.5.16'] },
  'Juniper Lane/Field Notes': { pick: null, custom: null, a: ['Seed and Sower', 'MRK.4.3'], b: ['Good Soil', 'MRK.4.8'] },
  // Kite Theory — Japanese praise (a: Japanese, b: English)
  'Kite Theory/Cloud Runner': { pick: null, custom: null, a: ['雲の柱', 'EXO.13.21'], b: ['Pillar of Cloud', 'EXO.13.21'] },
  'Kite Theory/Save Point': { pick: null, custom: null, a: ['避け所', 'PSA.46.1'], b: ['Refuge and Strength', 'PSA.46.1'] }, // "refuge"
  'Kite Theory/Boss Rush': { pick: null, custom: null, a: ['なめらかな石五つ', '1SA.17.40'], b: ['Five Smooth Stones', '1SA.17.40'] },
  'Kite Theory/Credits Roll': { pick: null, custom: null, a: ['いのちの書', 'REV.20.12'], b: ['Well Done', 'MAT.25.21'] }, // "book of life"
  // Ossa — Nepali meditative Psalms (a: Nepali, b: English)
  'Ossa/Salt Lines': { pick: null, custom: null, a: ['पृथ्वीको नुन', 'MAT.5.13'], b: ['Salt of the Earth', 'MAT.5.13'] },
  'Ossa/Undertow': { pick: null, custom: null, a: ['शान्त हो', 'MRK.4.39'], b: ['Peace, Be Still', 'MRK.4.39'] }, // "be still"
  'Ossa/Harbor Lights': { pick: null, custom: null, a: ['चाहेको बन्दरगाह', 'PSA.107.30'], b: ['The Desired Haven', 'PSA.107.30'] }, // "the desired harbour"
  // Polar Bloom — Spanish youth praise (a: Spanish, b: English)
  'Polar Bloom/Frostbite': { pick: null, custom: null, a: ['Un Corazón Limpio', 'PSA.51.10'], b: ['A Clean Heart', 'PSA.51.10'] },
  'Polar Bloom/Aurora Rush': { pick: null, custom: null, a: ['Como el Alba', 'HOS.6.3'], b: ['Like the Dawn', 'HOS.6.3'] },
  'Polar Bloom/Glacier Run': { pick: null, custom: null, a: ['Corred para Ganar', '1CO.9.24'], b: ['Run to Win', '1CO.9.24'] },
};

const TABLES = { artist: ARTISTS, album: ALBUMS, track: TRACKS };

/**
 * The name to show for a CATALOG name: the owner's own name, else the picked
 * option, else the CATALOG name itself (so an unapproved draft changes nothing).
 * kind: 'artist' | 'album' | 'track'; key as in the tables above.
 */
export function displayName(kind, key, fallback) {
  const entry = TABLES[kind]?.[key];
  if (!entry) return fallback;
  return entry.custom || entry[entry.pick]?.[0] || fallback;
}
