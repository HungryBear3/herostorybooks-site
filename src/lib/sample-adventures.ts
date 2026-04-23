export interface SampleAdventurePage {
  subtitle: string;
  story: string;
  image?: string;
  sceneTitle?: string;
  sceneAccent?: string;
}

export interface SampleAdventure {
  name: string;
  title: string;
  pages: SampleAdventurePage[];
}

export const SAMPLE_ADVENTURES: SampleAdventure[] = [
  {
    name: 'Brave Explorer',
    title: "Marcus's Great Jungle Discovery",
    pages: [
      {
        subtitle: 'Page 1 - The Quest Begins',
        image: '/assets/explorer-sample.png',
        story: "Marcus put on his explorer hat and picked up his trusty backpack. Deep in the jungle, ancient ruins were waiting to be discovered. With courage in his heart, he stepped into the emerald forest, ready for the adventure of a lifetime.",
      },
      {
        subtitle: 'Page 2 - Ancient Ruins',
        image: '/assets/brave-explorer-page-2.png',
        sceneTitle: 'Ancient Ruins Revealed',
        sceneAccent: 'from-emerald-500 via-teal-500 to-lime-400',
        story: "As Marcus pushed through the thick vines, ancient stone ruins appeared in the jungle. His eyes grew wide with wonder. Could this be the legendary Lost City? Each careful step brought him closer to solving the ancient mystery.",
      },
      {
        subtitle: 'Page 3 - Hidden Map',
        image: '/assets/brave-explorer-page-3.png',
        sceneTitle: 'A Clue Hidden in the Moss',
        sceneAccent: 'from-emerald-700 via-green-600 to-yellow-500',
        story: "Behind a curtain of vines, Marcus found a weathered stone map with glowing path lines and simple picture-like icons. He traced the route with his fingertips and realized the treasure chamber was deeper in the ruins than anyone had imagined.",
      },
      {
        subtitle: 'Page 4 - The Treasure Chamber',
        image: '/assets/brave-explorer-page-4.png',
        sceneTitle: 'The Golden Chamber',
        sceneAccent: 'from-yellow-500 via-amber-400 to-orange-400',
        story: "A golden doorway opened into a chamber filled with artifacts, decorative wall art, and sparkling light. Marcus took a deep breath, remembered to stay brave, and stepped inside to make the discovery of a lifetime.",
      },
      {
        subtitle: 'Page 5 - The Discovery',
        image: '/assets/brave-explorer-page-5.png',
        sceneTitle: 'A Hero Remembered',
        sceneAccent: 'from-amber-500 via-orange-500 to-rose-400',
        story: "Marcus raised the artifact into the sunlight and the whole jungle glowed. He had done it. The world would remember Marcus as the brave explorer who found the Lost City and shared its story with everyone back home.",
      },
    ],
  },
  {
    name: 'Space Voyager',
    title: "Zara's Cosmic Adventure",
    pages: [
      {
        subtitle: 'Page 1 - Blast Off',
        image: '/assets/space-sample.png',
        story: "Captain Zara climbed into the cockpit of the starship Aurora. The countdown began: 5... 4... 3... 2... 1... BLAST OFF! The rockets roared to life as Zara soared through the clouds toward the infinite cosmos, leaving Earth far below.",
      },
      {
        subtitle: 'Page 2 - Through the Nebula',
        image: '/assets/space-voyager-page-2.png',
        sceneTitle: 'A Ribbon of Starlight',
        sceneAccent: 'from-indigo-700 via-fuchsia-600 to-sky-400',
        story: "The Aurora glided through a glowing nebula that shimmered like liquid light. Zara watched constellations twist around the cockpit windows and steered carefully toward an uncharted planet sparkling ahead.",
      },
      {
        subtitle: 'Page 3 - Alien Planet',
        image: '/assets/space-voyager-page-3.png',
        sceneTitle: 'A New World to Explore',
        sceneAccent: 'from-violet-700 via-purple-600 to-cyan-400',
        story: "The ship descended onto a swirling purple planet filled with bioluminescent plants and twin moons. Zara explored the landscape in awe, taking notes on every glowing flower and crater she discovered.",
      },
      {
        subtitle: 'Page 4 - Signal from the Sky',
        image: '/assets/space-voyager-page-4.png',
        sceneTitle: 'Friendly Lights in Orbit',
        sceneAccent: 'from-sky-600 via-cyan-500 to-indigo-500',
        story: "A gentle signal pulsed from the horizon. Zara followed it to a floating observatory where lights blinked in greeting. She realized she was not alone in the galaxy after all.",
      },
      {
        subtitle: 'Page 5 - New Friends',
        image: '/assets/space-voyager-page-5.png',
        sceneTitle: 'Welcome Among the Stars',
        sceneAccent: 'from-cyan-500 via-blue-500 to-indigo-700',
        story: "Friendly alien creatures welcomed Zara with warm glows and gentle chirps. They shared stories of the stars, and Zara learned that the greatest discoveries are often the friendships we make along the way.",
      },
    ],
  },
  {
    name: 'Ocean Dreams',
    title: "Lily's Underwater Kingdom",
    pages: [
      {
        subtitle: 'Page 1 - Dive Deep',
        image: '/assets/ocean-sample.png',
        story: "Lily took a deep breath and dove beneath the sparkling waves. Suddenly, a magical transformation occurred. Her legs became a shimmering tail, and she could breathe underwater. A kingdom of coral and wonders opened before her eyes.",
      },
      {
        subtitle: 'Page 2 - Coral Gardens',
        image: '/assets/ocean-dreams-page-2.png',
        sceneTitle: 'A City Beneath the Waves',
        sceneAccent: 'from-cyan-600 via-sky-500 to-teal-400',
        story: "She swam through towering coral gardens where fish glittered like confetti. Every corner of the sea felt alive with color, music, and swirling schools of friendly sea creatures.",
      },
      {
        subtitle: 'Page 3 - Hidden Treasures',
        image: '/assets/ocean-dreams-page-3.png',
        sceneTitle: 'Pearls, Maps, and Secret Caves',
        sceneAccent: 'from-teal-600 via-emerald-500 to-cyan-400',
        story: "Lily discovered a secret chamber tucked behind a curtain of kelp. Inside were pearl necklaces, ancient maps, and treasures from forgotten ships — all sparkling in the filtered sunlight.",
      },
      {
        subtitle: 'Page 4 - The Guardian Bell',
        image: '/assets/ocean-dreams-page-4.png',
        sceneTitle: 'A Song That Echoed Through the Sea',
        sceneAccent: 'from-blue-600 via-cyan-500 to-teal-500',
        story: "At the center of the chamber rested a silver bell. When Lily rang it, the sound rippled through the water and called dolphins, turtles, and bright schools of fish to her side.",
      },
      {
        subtitle: 'Page 5 - Ocean Friends',
        image: '/assets/ocean-dreams-page-5.png',
        sceneTitle: 'Guardian of the Seas',
        sceneAccent: 'from-cyan-500 via-sky-500 to-blue-700',
        story: "Dolphins, sea turtles, and rainbow fish danced around Lily in celebration. She had been welcomed as the Guardian of the Seas, and she promised to protect the kingdom she now called home.",
      },
    ],
  },
  {
    name: 'Dinosaur Discovery',
    title: "Sam's Prehistoric Adventure",
    pages: [
      {
        subtitle: 'Page 1 - Time Travel',
        image: '/assets/dino-sample.png',
        story: "Sam found a mysterious crystal that glowed with ancient energy. In a flash of light, Sam was transported back 65 million years to the age of dinosaurs. Towering ferns and prehistoric creatures surrounded him in an impossible world.",
      },
      {
        subtitle: 'Page 2 - Footprints in the Ferns',
        image: '/assets/dinosaur-discovery-page-2.png',
        sceneTitle: 'A Trail Through Prehistory',
        sceneAccent: 'from-lime-600 via-green-500 to-emerald-400',
        story: "Massive footprints led Sam through a valley of giant ferns. He followed them carefully, listening to the rustle of the ancient forest and wondering which dinosaur had passed by just moments earlier.",
      },
      {
        subtitle: 'Page 3 - Dinosaur Friends',
        image: '/assets/dinosaur-discovery-page-3.png',
        sceneTitle: 'A Gentle Giant Appears',
        sceneAccent: 'from-green-700 via-lime-600 to-amber-400',
        story: "A gentle Triceratops approached Sam with curious eyes. Rather than fear, there was friendship between them. Soon, a whole dinosaur family welcomed Sam into their world.",
      },
      {
        subtitle: 'Page 4 - Race Across the Valley',
        image: '/assets/dinosaur-discovery-page-4.png',
        sceneTitle: 'Running With Dinosaurs',
        sceneAccent: 'from-amber-500 via-orange-400 to-lime-500',
        story: "Together they raced across an open valley while volcanoes glowed in the distance. Sam laughed as his new friends showed him hidden nests, waterfalls, and places no modern explorer had ever seen.",
      },
      {
        subtitle: 'Page 5 - Return Home',
        image: '/assets/dinosaur-discovery-page-5.png',
        sceneTitle: 'A Story to Keep Forever',
        sceneAccent: 'from-orange-500 via-amber-500 to-rose-400',
        story: "As the crystal glowed again, Sam said goodbye to his dinosaur friends. Back in his own time, he held the crystal close and smiled, knowing he would never forget the day he walked with dinosaurs.",
      },
    ],
  },
];
