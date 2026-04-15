import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';
const MODEL_ID     = '6b645e3a-d64f-4341-a6d8-7a3690fbf042';

const STYLE_PREFIX =
  'Children\'s book illustration, clean bold black outlines, bright vivid colors, ' +
  'cute cartoon style, big expressive round eyes, chubby friendly proportions, ' +
  'smooth flat coloring with soft shading, cheerful warm atmosphere. ';

// ── Generate one image via Leonardo ──────────────────────────────
// charRefUrl : URL of page-1 image used as character reference (null for page 1 itself)
async function generateWithLeonardo(apiKey, prompt, charRefUrl = null) {
  const body = {
    prompt,
    modelId:     MODEL_ID,
    width:       1024,
    height:      1024,
    num_images:  1,
    presetStyle: 'ILLUSTRATION',
    alchemy:     true,
    photoReal:   false,
  };

  // Character reference locks face + outfit across all pages
  if (charRefUrl) {
    body.characterRef = {
      identity0: { images: [charRefUrl] },
    };
    body.characterRefStrength = 0.8;
  }

  const genRes = await fetch(`${LEONARDO_API}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const genData     = await genRes.json();
  const generationId = genData.sdGenerationJob?.generationId;
  if (!generationId) throw new Error('Leonardo: pas de generationId — ' + JSON.stringify(genData));

  // Poll toutes les 2s, max 25 fois = 50s
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes  = await fetch(`${LEONARDO_API}/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    const gen      = pollData.generations_by_pk;
    if (gen?.status === 'COMPLETE') {
      const url = gen.generated_images?.[0]?.url;
      if (!url) throw new Error('Leonardo: aucune image dans la réponse');
      return url;
    }
    if (gen?.status === 'FAILED') throw new Error('Leonardo: génération échouée');
  }
  throw new Error('Leonardo: timeout');
}

// ── Upload image to Supabase Storage ─────────────────────────────
async function uploadToSupabase(supabase, imageUrl, filename) {
  const imgRes    = await fetch(imageUrl);
  const imgBuffer = await imgRes.arrayBuffer();

  const { error } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(imgBuffer), { contentType: 'image/png' });
  if (error) throw new Error(error.message);

  const { data: { publicUrl } } = supabase.storage.from('images').getPublicUrl(filename);
  return publicUrl;
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { story, age, gender, childDescription } = req.body;
    if (!story?.pages?.length) return res.status(400).json({ error: 'Histoire manquante' });

    const openai      = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const leonardoKey = process.env.LEONARDO_API_KEY;
    const supabase    = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';

    // ── 1. GPT génère UNE description précise et fixe du personnage ──
    const charRes = await openai.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.1,
      max_tokens:  80,
      messages: [{
        role: 'user',
        content:
          `Describe precisely a ${age || 5}-year-old ${genderStr} character for a children's book illustration.` +
          (childDescription ? ` Traits: ${childDescription}.` : '') +
          ` Include ONLY: hair (color+style), eye color, skin tone, face shape, ` +
          `and ONE fixed outfit (specific shirt, pants/skirt, shoes). Max 40 words. English.`,
      }],
    });
    const characterDesc = charRes.choices[0].message.content.trim();
    console.log('[images] Character locked:', characterDesc);

    // Prompt identique pour toutes les pages
    const buildPrompt = (page) =>
      STYLE_PREFIX +
      `SAME character every image (face, hair, outfit never change): ${characterDesc}. ` +
      `Scene: ${page.imagePrompt}. No text, no letters in image.`;

    // ── 2. Générer la page 1 EN PREMIER → référence de personnage ──
    const firstPage = story.pages[0];
    let   charRefUrl = null;

    console.log('[images] Generating page 1 (character reference)...');
    try {
      const rawUrl   = await generateWithLeonardo(leonardoKey, buildPrompt(firstPage));
      const filename = `page-${Date.now()}-p1.png`;
      charRefUrl     = await uploadToSupabase(supabase, rawUrl, filename);
      console.log('[images] Page 1 done →', charRefUrl);
    } catch (err) {
      console.error('[images] Page 1 failed:', err.message);
    }

    // ── 3. Générer les pages restantes EN PARALLÈLE avec characterRef ──
    const remaining = story.pages.slice(1);
    const restResults = await Promise.all(
      remaining.map(async (page) => {
        try {
          // charRefUrl garantit le même visage + tenue sur toutes les pages
          const rawUrl   = await generateWithLeonardo(leonardoKey, buildPrompt(page), charRefUrl);
          const filename = `page-${Date.now()}-${Math.random().toString(36).slice(2)}-p${page.pageNumber}.png`;
          const publicUrl = await uploadToSupabase(supabase, rawUrl, filename);
          console.log(`[images] Page ${page.pageNumber} done`);
          return { pageNumber: page.pageNumber, imageUrl: publicUrl };
        } catch (err) {
          console.error(`[images] Page ${page.pageNumber} failed:`, err.message);
          return { pageNumber: page.pageNumber, imageUrl: null };
        }
      })
    );

    // ── 4. Assembler les résultats ────────────────────────────────
    const allResults = [
      { pageNumber: firstPage.pageNumber, imageUrl: charRefUrl },
      ...restResults,
    ];

    const storyWithImages = {
      ...story,
      pages: story.pages.map(page => {
        const r = allResults.find(x => x.pageNumber === page.pageNumber);
        return { ...page, imageUrl: r?.imageUrl || null };
      }),
    };

    const ok = allResults.filter(r => r.imageUrl).length;
    console.log(`[images] ${ok}/${story.pages.length} images generated`);

    return res.status(200).json(storyWithImages);
  } catch (err) {
    console.error('[images]', err);
    return res.status(500).json({ error: err.message });
  }
}
