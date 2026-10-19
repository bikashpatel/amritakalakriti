'use strict';
// Seeds the store on first run: art-form categories, a starter collection and the admin account.
// Run `npm run seed` to (re)create the admin user from .env; catalog seeding only happens on an empty store.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');
const { slugify } = require('./helpers');

const CATEGORIES = [
  { name: 'Canvas Paintings', tagline: 'Acrylic & oil on stretched canvas', description: 'Rich, layered paintings on gallery-wrapped cotton canvas — landscapes, florals and semi-abstract works that bring warmth and colour to a room.' },
  { name: 'Watercolor', tagline: 'Delicate washes on cotton paper', description: 'Luminous watercolours painted on 300gsm cotton paper — soft blooms, misty mornings and quiet moments in nature.' },
  { name: 'Pattachitra', tagline: 'Patta painting from Odisha', description: 'Pattachitra — “picture on cloth” — is the centuries-old scroll painting tradition of Odisha, known for ornate borders, bold outlines and natural pigments on treated cloth.' },
  { name: 'Madhubani', tagline: 'Mithila folk art of Bihar', description: 'Madhubani art from the Mithila region uses double-line outlines, fine hatching and vivid natural colours to tell stories of nature, love and prosperity.' },
  { name: 'Warli Art', tagline: 'Tribal art of Maharashtra', description: 'Warli paintings use simple circles, triangles and lines in white on earthy mud tones to celebrate dance, harvest and village life.' },
  { name: 'Mandala Art', tagline: 'Meditative sacred geometry', description: 'Hand-drawn mandalas built ring by ring — meditative, symmetrical and full of fine detail.' },
  { name: 'Gond Art', tagline: 'Dots & lines from Madhya Pradesh', description: 'Gond art fills bold forms of trees, birds and animals with intricate dots and dashes — a joyful tribal art form from central India.' },
  { name: 'Handcrafted Decor', tagline: 'Painted plates, diyas & lippan', description: 'Hand-painted décor and craft pieces — wall plates, diyas and Kutch lippan mirror work — to bring handmade art into everyday spaces.' },
];

const STUDIO = 'AmritaKalakriti Studio';
// [category index, title, file, medium, dimensions, price, compare_at, stock, featured, short, long]
const PRODUCTS = [
  [0, 'Golden Dusk over the Ganga', 'golden-dusk-ganga', 'Acrylic on stretched canvas', '36 × 24 in', 18500, null, 1, 1,
    'The last light of evening pours gold over the ghats as boats drift home.',
    'Painted in thick, glowing layers of acrylic, this canvas captures the hour when the river turns to molten gold and temple silhouettes soften into the sky. Small boats drift across broken reflections, and the brushwork carries the stillness of an evening aarti.\n\nGallery-wrapped on 1.5 inch stretcher bars, painted on the sides, and ready to hang.'],
  [0, 'Monsoon Hills', 'monsoon-hills', 'Oil on canvas', '30 × 20 in', 14900, 16500, 1, 0,
    'Rain-washed ridges of the Western Ghats, wrapped in drifting cloud.',
    'Layer upon layer of misty greens and blue-greys recreate the drama of the monsoon over the Western Ghats — heavy clouds, slanting rain and a thread of waterfall catching the light.\n\nOil on cotton canvas with a protective varnish. Signed on the front.'],
  [0, 'Lotus Pond Reverie', 'abstract-lotus-pond', 'Acrylic, palette knife on canvas', '30 × 30 in', 12500, null, 1, 1,
    'Bold palette-knife strokes of teal, rose and gold suggest a pond in bloom.',
    'A semi-abstract celebration of the lotus pond, built with confident palette-knife strokes. Up close it is pure texture and colour; from across the room the blooms and lily pads emerge.\n\nA statement piece for living rooms and entryways.'],
  [1, 'Lotus in Morning Mist', 'lotus-morning-mist', 'Watercolor on 300gsm cotton paper', '16 × 12 in', 4800, null, 1, 1,
    'Two lotus blooms and a bud rise through a soft blue haze.',
    'Wet-in-wet washes let the colours bloom and bleed naturally, giving this lotus study its gentle, misty mood. Painted on archival 100% cotton paper.\n\nShipped unframed in a rigid envelope with a backing board. Fits a standard 16 × 12 in frame.'],
  [1, 'Backwaters at Dawn', 'backwaters-dawn', 'Watercolor on 300gsm cotton paper', '20 × 14 in', 5600, null, 1, 0,
    'Coconut palms lean over the still, peach-lit waters of Kerala.',
    'A quiet dawn on the Kerala backwaters — palm silhouettes, a lone canoe and the first peach and lavender light on still water. Painted with transparent layered washes.\n\nShipped unframed with a certificate of authenticity.'],
  [1, 'Kingfisher & Blossoms', 'kingfisher-blossoms', 'Watercolor & gouache on paper', '15 × 11 in', 3900, null, 1, 0,
    'A tiny jewel-blue kingfisher rests among pink blossoms.',
    'A small, joyful study of the common kingfisher among spring blossoms, painted with watercolour and fine gouache highlights.\n\nA lovely gift for bird lovers and a bright touch for a reading corner.'],
  [2, 'Konark Sun — Surya Pattachitra', 'konark-sun', 'Natural colours on tussar silk (Pattachitra)', '24 × 24 in', 9800, 11200, 1, 1,
    'The sun god Surya, inspired by the great chariot wheel of Konark.',
    'In the Pattachitra tradition of Odisha, Surya’s face glows at the centre of an ornamented wheel, surrounded by radiating rays and layered borders of floral motifs. Painted with natural pigments and fine single-hair brushes.\n\nOn treated tussar silk — can be framed or hung as a scroll.'],
  [2, 'Tree of Life', 'tree-of-life-patta', 'Natural colours on treated cloth (Pattachitra)', '24 × 18 in', 11500, null, 1, 1,
    'A symmetric tree of life alive with parrots and peacocks.',
    'The tree of life — a symbol of growth, family and continuity — rendered in classic Pattachitra style with bold outlines, a deep red ground and intricate ornamental borders. Birds perch on curling branches among stylised leaves.\n\nEach line is painted by hand; no two pieces are ever the same.'],
  [2, 'Matsya — The Divine Fish', 'matsya-patta', 'Natural colours on treated cloth (Pattachitra)', '18 × 12 in', 7200, null, 1, 0,
    'Matsya, the fish avatar, among lotuses and waves.',
    'An ornamented fish — Matsya, the first avatar of Vishnu — glides between lotuses and stylised waves. Classic Pattachitra palette of vermilion, yellow, white and black with a decorative border.\n\nA meaningful piece for prayer rooms and entrances.'],
  [3, 'Fish Pair — Symbol of Prosperity', 'madhubani-fish-pair', 'Natural colours on handmade paper (Madhubani)', '15 × 15 in', 6500, null, 1, 1,
    'Two fish curve together — a Mithila blessing of fertility and abundance.',
    'In Mithila homes, the fish pair is painted for weddings as a symbol of fertility, good luck and abundance. This piece uses traditional double-line outlines filled with fine hatching and vivid natural colours.\n\nOn handmade paper; shipped flat with a stiff backing board.'],
  [3, 'Mayur — Dancing Peacock', 'madhubani-peacock', 'Natural colours on handmade paper (Madhubani)', '20 × 16 in', 7900, null, 1, 0,
    'A peacock unfurls a richly patterned tail among flowers.',
    'The peacock, symbol of love and beauty, dances with its tail spread wide — every feather filled with the cross-hatching and dot work that make Madhubani so distinctive.\n\nSigned and dated by the artist.'],
  [4, 'Tarpa Dance Circle', 'warli-tarpa-dance', 'Acrylic on mud-toned canvas (Warli)', '18 × 18 in', 4500, null, 1, 1,
    'Villagers dance in spiralling circles around the tarpa player.',
    'The tarpa dance is the heart of Warli celebration: men and women link hands and spiral around the musician playing the tarpa, a long wind instrument. Painted in white on a warm earthen ground.\n\nGallery-wrapped and ready to hang.'],
  [4, 'Village Harvest', 'warli-village-life', 'Acrylic on mud-toned canvas (Warli)', '24 × 18 in', 5200, null, 1, 0,
    'Huts, farmers, bullock carts and birds — a busy harvest day.',
    'A lively Warli scene of village life at harvest time: farmers in the fields, women carrying water pots, a bullock cart and birds in the trees — all drawn with the tradition’s simple circles, triangles and lines.\n\nA conversation piece for any wall.'],
  [5, 'Golden Bloom Mandala', 'mandala-golden-bloom', 'Metallic ink & acrylic on canvas board', '16 × 16 in', 3500, null, 2, 1,
    'Gold petals unfold ring by ring on a deep maroon ground.',
    'A meditative mandala drawn ring by ring in metallic gold and ochre over deep maroon. Hours of fine pen work create a piece that shimmers as the light changes.\n\nOn primed canvas board — ideal for a desk or small wall.'],
  [5, 'Lotus Chakra Mandala', 'mandala-lotus-chakra', 'Pen & watercolor on paper', '12 × 12 in', 4200, null, 1, 0,
    'Rose, sage and gold petals radiating from a lotus heart.',
    'Inspired by the lotus of the heart chakra, this mandala layers fine ink detail with soft washes of rose, sage and gold.\n\nOn 300gsm paper; shipped flat.'],
  [6, 'Gond Tree of Birds', 'gond-tree-birds', 'Acrylic on canvas (Gond)', '24 × 18 in', 8400, null, 1, 1,
    'A great tree alive with colourful birds, filled with dots and dashes.',
    'In Gond belief, trees are home to spirits and shelter for every creature. This tree bursts with birds and leaf clusters, each form filled with the dot and dash patterns that define Gond art.\n\nA cheerful piece for living rooms and children’s rooms alike.'],
  [6, 'Gond Sacred Fish', 'gond-sacred-fish', 'Ink & acrylic on paper (Gond)', '20 × 14 in', 5900, null, 1, 0,
    'Patterned fish swimming among water plants.',
    'Fish swim through flowing water plants, their bodies filled with intricate Gond patterns of dots, scales and lines.\n\nOn heavy art paper — frame it with a wide mat for best effect.'],
  [7, 'Hand-painted Mandala Wall Plate', 'mandala-wall-plate', 'Acrylic on MDF plate, varnished', '12 in diameter', 1499, 1799, 8, 1,
    'A decorative plate painted with a bright, detailed mandala.',
    'A 12 inch decorative wall plate hand-painted with a vibrant mandala and sealed with a glossy protective varnish. Comes with a hook on the back, ready to hang.\n\nA thoughtful housewarming gift.'],
  [7, 'Hand-painted Diya Set (6)', 'painted-diya-set', 'Terracotta, hand-painted', 'Set of 6 · 3 in each', 899, null, 20, 0,
    'Six clay diyas hand-painted with festive dot work.',
    'A set of six terracotta diyas, each painted by hand with bright colours and dot patterns. Perfect for Diwali, pujas and gifting.\n\nUse with ghee, oil or tea lights.'],
  [7, 'Lippan Art Mirror Panel', 'lippan-mirror-panel', 'Mud relief & mirrors on MDF (Lippan, Kutch)', '18 in diameter', 2800, null, 4, 1,
    'Kutch-style mud relief with tiny mirrors that catch the light.',
    'Lippan kaam is the mud-and-mirror relief work of Kutch, Gujarat. Raised white lines and hundreds of tiny mirrors form a geometric pattern that sparkles in daylight and lamplight alike.\n\nLightweight MDF base with a hanging hook.'],
];

function ensureAdmin({ force = false } = {}) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing && !force) return null;
  let password = config.admin.password;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', is_active = 1`)
    .run(config.admin.name, config.admin.email, hash);
  console.log(`  Admin account ready: ${config.admin.email}`);
  if (generated) console.log(`  Generated admin password: ${password}   (set ADMIN_PASSWORD in .env to choose your own)`);
  return { email: config.admin.email };
}

const seedCatalog = db.transaction(() => {
  const insCat = db.prepare('INSERT INTO categories (name, slug, tagline, description, image, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const insProd = db.prepare(`INSERT INTO products (category_id, title, slug, short_description, description, artist, medium, dimensions, year,
      sku, price, compare_at_price, stock, image, is_featured) VALUES (@category_id, @title, @slug, @short_description, @description,
      @artist, @medium, @dimensions, @year, @sku, @price, @compare_at_price, @stock, @image, @is_featured)`);
  const catIds = CATEGORIES.map((c, i) => {
    const firstArt = PRODUCTS.find((p) => p[0] === i);
    return Number(insCat.run(c.name, slugify(c.name), c.tagline, c.description, firstArt ? `/images/art/${firstArt[2]}.svg` : null, i).lastInsertRowid);
  });
  PRODUCTS.forEach(([ci, title, file, medium, dimensions, price, compareAt, stock, featured, short, long], i) => {
    insProd.run({
      category_id: catIds[ci], title, slug: slugify(title), short_description: short, description: long,
      artist: STUDIO, medium, dimensions, year: i % 3 === 0 ? '2025' : '2026', sku: `AK-${String(i + 1).padStart(3, '0')}`,
      price, compare_at_price: compareAt, stock, image: `/images/art/${file}.svg`, is_featured: featured,
    });
  });
});

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) {
    seedCatalog();
    console.log(`  Seeded ${CATEGORIES.length} categories and ${PRODUCTS.length} artworks.`);
  }
  ensureAdmin();
}

module.exports = { seedIfEmpty, ensureAdmin };

if (require.main === module) {
  seedIfEmpty();
  if (process.argv.includes('--reset-admin')) ensureAdmin({ force: true });
}
