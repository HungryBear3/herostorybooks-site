/**
 * Test-only historical orders bridge v2: exact UTF-16 spans and SHA-256 pins.
 * Preimage: accepted HEAD 46ca97bece38c92b6b8c7d39ecd607ebbe4b6e30,
 * after the original eleven ordered inverses. Postimage: historical BASE
 * 6aef22c36e9f9b897ce7d7fae51660af46e45c8a. Descending preimage offsets.
 *
 * Literal source comes ONLY from those two fixed, whole-file-hash-checked Git
 * objects, not the candidate under test. This is span data, not encoded source
 * or imports: it avoids misclassifying an inert quoted source fixture as a real
 * confirmation-module importer. Candidate slices still must match independently
 * pinned hashes, exact locations and one occurrence before any replacement.
 * Unchanged candidate bytes flow through to genuine whole historical equality.
 *
 * Covers confirmation privacy/state, attribution/payment winner, print commerce,
 * logging/list types, semantic claim generations, bound namespace transactions
 * and expired-provider evidence. Original b5 assertion is superseded, NOT passed;
 * its original pin, assertion and native RED remain in the external packet.
 */
export interface HistoricalOrdersBridgeHunk {
  readonly id: string;
  readonly offset: number;
  readonly candidate: string;
  readonly base: string;
  readonly sha256: string;
  readonly baseSha256: string;
}
export const HISTORICAL_ORDERS_BRIDGE_SPANS_V2 = [
  {
    "id": "head46-to-base6a-v2-28",
    "offset": 210285,
    "length": 701,
    "baseOffset": 160555,
    "baseLength": 438,
    "sha256": "1e425a3253688c683bcfdc902dc19e52df5781de1af0803cc4c51a56d8e42ac1",
    "baseSha256": "ad051564c84bdc9062bdd4e6dc2d4d6934055f676d8b0301c6b2050e826a0ff8"
  },
  {
    "id": "head46-to-base6a-v2-27",
    "offset": 190164,
    "length": 326,
    "baseOffset": 140553,
    "baseLength": 207,
    "sha256": "9af75506f6d051196866c183f78b66d2fd99dec2c4bb6b519427891bbedf8725",
    "baseSha256": "770e4bffc4e7d8a00482317c39e1a7cde4c1f0a2c2b834085081fb80ac07c6d3"
  },
  {
    "id": "head46-to-base6a-v2-26",
    "offset": 189177,
    "length": 222,
    "baseOffset": 139604,
    "baseLength": 184,
    "sha256": "a658196d165b5279eabd64dd04a3716c0493f1f49ea80e6197081f78177bf800",
    "baseSha256": "a59a47e554459a4075835562bedc695882a34beb904ce1d2f18d54f750d62e18"
  },
  {
    "id": "head46-to-base6a-v2-25",
    "offset": 174525,
    "length": 13840,
    "baseOffset": 138312,
    "baseLength": 480,
    "sha256": "af52da92160e0c5afe7b21dfb7bc5f1cdb8d2961762a6eafb1a0802662b66868",
    "baseSha256": "8909a11e1e7927b2e456b57f7bfe3d612651cf647f91dd9f0886a5d2e5472bd6"
  },
  {
    "id": "head46-to-base6a-v2-24",
    "offset": 169177,
    "length": 575,
    "baseOffset": 133259,
    "baseLength": 280,
    "sha256": "dd62fb500d5ba424ef3ffaea18ec4600e00e03234e802e8b1919464515b0170e",
    "baseSha256": "cf61d8b94742ad17a88e0f47dfb1766dfb40290e433c1e6600755332db5cecc0"
  },
  {
    "id": "head46-to-base6a-v2-23",
    "offset": 146846,
    "length": 18366,
    "baseOffset": 129080,
    "baseLength": 214,
    "sha256": "c160adf147c1fec438051966ecca4a329942e043191b680ade765cb5efecf8ee",
    "baseSha256": "dc6143131d1850103708af406d0ea1c4e179cb596cf43c052cb86bad7598b0e3"
  },
  {
    "id": "head46-to-base6a-v2-22",
    "offset": 144596,
    "length": 618,
    "baseOffset": 127059,
    "baseLength": 389,
    "sha256": "5fb82950c7f5836431c83008fc29308c75ff7f83f42e29a9d82165ca449aeda2",
    "baseSha256": "5be08e9dd028e47ed665cb13cde4491ea78c51d663e883dbe1d1fc434febb9af"
  },
  {
    "id": "head46-to-base6a-v2-21",
    "offset": 110107,
    "length": 1100,
    "baseOffset": 93257,
    "baseLength": 413,
    "sha256": "3763db6d68eb27dbc4536dc812f04f41b713cbc2c3727c866c364a86473239a1",
    "baseSha256": "31539ab879204ba523b87b9fab56db52a3e93e26773b461741b97c486fc2d96d"
  },
  {
    "id": "head46-to-base6a-v2-20",
    "offset": 106259,
    "length": 944,
    "baseOffset": 89524,
    "baseLength": 829,
    "sha256": "03d3f81ad61dbf298339675ea3ef1fdd4df93ec6ccdc321b7cbe0bf48d95eb36",
    "baseSha256": "c97461a67cb545d5ce42d9bdc4d4cf1ba3bf25ce72dc376a8021a10debf128b1"
  },
  {
    "id": "head46-to-base6a-v2-19",
    "offset": 105008,
    "length": 662,
    "baseOffset": 88749,
    "baseLength": 186,
    "sha256": "637d7054a61a6155a0fd33c19dda9732222034631a466217922bda947436eb71",
    "baseSha256": "84d140ba6c9f32e3c18635ee40a54484eff3bb48dcb9a33bdcc0fd34850b4856"
  },
  {
    "id": "head46-to-base6a-v2-18",
    "offset": 102332,
    "length": 715,
    "baseOffset": 86483,
    "baseLength": 305,
    "sha256": "b0427ef39933453a02092e5d3cd86f3e3bca89bf109a3b792ed6a89831e760c4",
    "baseSha256": "19887bf9835953c4a1c4e96424f16ba4c51397413f10bd6511485d78e3a0f6fb"
  },
  {
    "id": "head46-to-base6a-v2-17",
    "offset": 100959,
    "length": 302,
    "baseOffset": 85151,
    "baseLength": 261,
    "sha256": "6135dbf7e7e1902b0ac5ec69c57f0e7d9bfb0510c47170e99fbc56b3cca2afeb",
    "baseSha256": "3626b7bf0ee976bef8cddddf6ec96f7bd2886ee8aa9517ceeae5e1f1874e9cc2"
  },
  {
    "id": "head46-to-base6a-v2-16",
    "offset": 97041,
    "length": 379,
    "baseOffset": 81251,
    "baseLength": 361,
    "sha256": "3c842d0b0dee8333ffefb2d3bf09fbf56f83a3bd2c883790ab41a340a53f27b0",
    "baseSha256": "82ab55bfdd6b2a838c973d621c23546e50724d125793a230bb9c536532dcd722"
  },
  {
    "id": "head46-to-base6a-v2-15",
    "offset": 94831,
    "length": 336,
    "baseOffset": 79066,
    "baseLength": 311,
    "sha256": "94ae496e8cbc08aa6788f3db8ab73af0c5b4a787e92fa4a92cbe064af7f49bf8",
    "baseSha256": "a1c399001f921336734f189363cedd53a323f2f59b97026998b6f16201d44936"
  },
  {
    "id": "head46-to-base6a-v2-14",
    "offset": 85520,
    "length": 5676,
    "baseOffset": 75223,
    "baseLength": 208,
    "sha256": "ed458c1e994d0daa6190cb1a310eadc72ed5529b48ff765ef675fb218ba630d9",
    "baseSha256": "74305afbb0fda887d875db9b83201a47d86b986fc4f24fd2661f27a9cf2a2bc0"
  },
  {
    "id": "head46-to-base6a-v2-13",
    "offset": 84726,
    "length": 532,
    "baseOffset": 74704,
    "baseLength": 257,
    "sha256": "3e56ccab579391a7a89a51b59a1f628a9e7c8b2325b8c3bf3505bcae6c10787b",
    "baseSha256": "04473b9c57904a6f1b7f7fe50f7637189b32d803eb3fecf938ca3b0470a7634c"
  },
  {
    "id": "head46-to-base6a-v2-12",
    "offset": 67264,
    "length": 539,
    "baseOffset": 57462,
    "baseLength": 319,
    "sha256": "bb1f6102ad9ec50b81ece9588edfe96a0e70dde320afc8d9c0b5a85aea7cde02",
    "baseSha256": "ce9fa53733a5abf1713a64908f5dd789e95029b5b6b712a0acede0f46d2ea47b"
  },
  {
    "id": "head46-to-base6a-v2-11",
    "offset": 61875,
    "length": 279,
    "baseOffset": 52037,
    "baseLength": 315,
    "sha256": "896cb038e7bf7a8890b72346715627973ccf18f1d22d8ea2758c9b2fba0568f8",
    "baseSha256": "d890353e17ad92f2fc519682e81af050b1a20ef43cf08091a609bf3b57283e4d"
  },
  {
    "id": "head46-to-base6a-v2-10",
    "offset": 41769,
    "length": 4818,
    "baseOffset": 36516,
    "baseLength": 233,
    "sha256": "53acd4be4bb3af308ccd5d889f927652691dc465ac69d3038357a5c5e04d5314",
    "baseSha256": "e17f9b4055c34530598e5675a4fa39d8217f9a1bfacb4d96332d69d97cb310de"
  },
  {
    "id": "head46-to-base6a-v2-09",
    "offset": 37633,
    "length": 3660,
    "baseOffset": 35741,
    "baseLength": 299,
    "sha256": "d48f6f832896549b3ace5002a648e39c163a560b313ec77fea30cab3e48c913d",
    "baseSha256": "9dc6dd654d2b04cd6eadd62f7a972288b3be7e11b152ee0f5b17aca49ce3c412"
  },
  {
    "id": "head46-to-base6a-v2-08",
    "offset": 35621,
    "length": 682,
    "baseOffset": 34001,
    "baseLength": 410,
    "sha256": "32e90b7e95ee9a677e1794d24d330eff87bdf3534da84f6734b89a50d2bd397f",
    "baseSha256": "94bd44b71db19ed03469933cdd135ae406bc242bd2d5d08c7bdcb434ed546b83"
  },
  {
    "id": "head46-to-base6a-v2-07",
    "offset": 27872,
    "length": 375,
    "baseOffset": 26383,
    "baseLength": 244,
    "sha256": "c1164904c14cb993fa885c555b4965d6253623dd22069ce44fff0902a9dc75f3",
    "baseSha256": "d4b96db5b73ea8075666cdc66f69e75677defc6f183c67f88ee5171d3430dad6"
  },
  {
    "id": "head46-to-base6a-v2-06",
    "offset": 22599,
    "length": 429,
    "baseOffset": 21324,
    "baseLength": 215,
    "sha256": "3b17dbafcec3403c9c09b5e3d89484b234620308b3b55e0d49e69a4e58d1179b",
    "baseSha256": "a234ef40e8f09e012f1b6ef2a09ec917d21c1503e156223e8be3db7dfde79488"
  },
  {
    "id": "head46-to-base6a-v2-05",
    "offset": 22015,
    "length": 563,
    "baseOffset": 21111,
    "baseLength": 192,
    "sha256": "c2802a7a4f2dbbe3a233023ff26f4211c51b9836693a9538e0b2870ba5c45475",
    "baseSha256": "da7e1cf73813ac492bfe47f92a26b95ebf343d3649468c13b7e72ba0bb930f7f"
  },
  {
    "id": "head46-to-base6a-v2-04",
    "offset": 19529,
    "length": 521,
    "baseOffset": 18759,
    "baseLength": 387,
    "sha256": "2c8c5bd511a3ed0a8dc6f628b46fee0c16458a839533a86887912bcbb103fe8a",
    "baseSha256": "bc44e0767c2f76eca1b717d48fddc707a2833bedbe005759a9f5bedf6fc50292"
  },
  {
    "id": "head46-to-base6a-v2-03",
    "offset": 1490,
    "length": 586,
    "baseOffset": 749,
    "baseLength": 557,
    "sha256": "320a8bf0ccb0b9769e92d5e54d3b55856d1dcc03fd7d5b801631ea95d0d80b23",
    "baseSha256": "797314e7529069f35bdbb41d6a6cef85d708eedadaec9f5fc3f14fb1cf753f10"
  },
  {
    "id": "head46-to-base6a-v2-02",
    "offset": 400,
    "length": 1013,
    "baseOffset": 380,
    "baseLength": 292,
    "sha256": "defbdbc4afa1a15da02bc72862e596d7b5b230cc9f638d58f4833324d27d2b0d",
    "baseSha256": "57aa498d9a7ae92b0def281d70bc4193757dbf759bdb349353fae4b3048ae127"
  },
  {
    "id": "head46-to-base6a-v2-01",
    "offset": 0,
    "length": 347,
    "baseOffset": 0,
    "baseLength": 327,
    "sha256": "f7195b5d72be522b7a74260e0e3e7f66de8a9f4b18d7b4b465963381b3f00844",
    "baseSha256": "909e9129d94e1724408b7436dd3669adf98a4cf23fa769f8b76010a9edc092a5"
  }
] as const;
