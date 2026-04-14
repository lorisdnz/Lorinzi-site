import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';
// Leonardo Kino XL — meilleure cohérence de personnage
const MODEL_ID = '6b645e3a-d64f-4341-a6d8-7a3690fbf042';

// Style prefix identique pour TOUTES les images — ne jamais changer
const STYLE_PREFIX =
  'Children\'s book illustration, clean bold black outlines, bright vivid colors, ' +
  'cute cartoon style, big expressive round eyes, chubby friendly proportions, ' +
  'smooth flat coloring with soft shading, cheerful warm atmosphere. ';

async function generateWithLeonardo(apiKey, prompt, characterRefUrl = null) {
  const body = {
    prompt,
    modelId: MODEL_ID,
    width: 1024,
    height: 1024,
    num_images: 1,
    presetStyle: 'ILLUSTRATION',
    alchemy: true,
    photoReal: false,
  };

  // Use first image as character reference for all subsequent images
  if (characterRefUrl) {
    body.characterRef = {
      identity0: {
        images: [characterRefUrl],
      },
    };
    body.characterRefStrength = 0.8; // strong character identity lock
  }

  const genRes = await fetch(`${LEONARDO_API}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const genData = await genRes.json();
  const generationId = genData.sdGenerationJob?.generationId;
  if (!generationId) throw new Error('Leonardo: pas de generationId — ' + JSON.stringify(genData));

  // Poll until complete (max 90 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`${LEONARDO_API}/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    const gen = pollData.generations_by_pk;
    if (gen?.status === 'COMPLETE') {
      const url = gen.generated_images?.[0]?.url;
      if (!url) throw new Error('Leonardo: aucune image dans la réponse');
      return url;
    }
    if (gen?.status === 'FAILED') throw new Error('Leonardo: génération échouée');
  }
  throw new Error('Leonardo: timeout dépassé');
}

async function uploadToSupabase(supabase, imageUrl, filename) {
  const imgRes = await fetch(imageUrl);
  const imgBuffer = await imgRes.arrayBuffer();

  const { error: uploadErr } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(imgBuffer), { contentType: 'image/png' });

  if (uploadErr) throw new Error(uploadErr.message);

  const { data: { publicUrl } } = supabase.storage
    .from('images')
    .getPublicUrl(filename);

  return publicUrl;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { story, age, gender, childDescription } = req.body;

    if (!story?.pages?.length) {
      return res.status(400).json({ error: 'Données histoire manquantes' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const leonardoKey = process.env.LEONARDO_API_KEY;
    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';
    const ageStr = age || 5;

    // Step 1: GPT-4o génère UNE description précise du personnage
    const charPrompt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: `Define a precise visual description of a ${ageStr}-year-old ${genderStr} character for a children's book.
${childDescription ? `Physical traits: ${childDescription}.` : ''}
Describe ONLY: face shape, hair (color + style), eye color, skin tone, and one specific outfit (shirt color/pattern, pants/skirt, shoes).
Be very specific and simple. Max 40 words. English only.`
      }],
      temperature: 0.2,
      max_tokens: 80,
    });

    const characterDesc = charPrompt.choices[0].message.content.trim();
    console.log('[generate-images] Character:', characterDesc);

    // Build prompt for a given page
    function buildPrompt(page) {
      return (
        STYLE_PREFIX +
        `Main character (EXACT SAME in every image — identical face, hair, outfit): ${characterDesc}. ` +
        `Scene: ${page.imagePrompt}. ` +
        `No text, no letters, no words in the image.`
      );
    }

    // Step 2: Génère la PAGE 1 en premier (référence de personnage)
    const firstPage = story.pages[0];
    let firstImagePublicUrl = null;

    try {
      console.log('[generate-images] Generating page 1 (character reference)...');
      const firstRawUrl = await generateWithLeonardo(leonardoKey, buildPrompt(firstPage));
      const firstFilename = `page-${Date.now()}-${firstPage.pageNumber}.png`;
      firstImagePublicUrl = await uploadToSupabase(supabase, firstRawUrl, firstFilename);
      console.log('[generate-images] Page 1 done, URL:', firstImagePublicUrl);
    } catch (err) {
      console.error('[generate-images] Page 1 failed:', err.message);
    }

    // Step 3: Génère toutes les autres pages EN PARALLÈLE avec page 1 comme référence
    const remainingPages = story.pages.slice(1);

    const remainingResults = await Promise.all(
      remainingPages.map(async (page) => {
        try {
          console.log(`[generate-images] Generating page ${page.pageNumber}...`);
          // Use first image as character reference → same face, same outfit
          const imageUrl = await generateWithLeonardo(
            leonardoKey,
            buildPrompt(page),
            firstImagePublicUrl  // character reference from page 1
          );

          const filename = `page-${Date.now()}-${page.pageNumber}.png`;
          const publicUrl = await uploadToSupabase(supabase, imageUrl, filename);

          console.log(`[generate-images] Page ${page.pageNumber} done`);
          return { pageNumber: page.pageNumber, imageUrl: publicUrl };
        } catch (err) {
          console.error(`[generate-images] Page ${page.pageNumber} failed:`, err.message);
          return { pageNumber: page.pageNumber, imageUrl: null };
        }
      })
    );

    // Combine results: page 1 + remaining
    const allResults = [
      { pageNumber: firstPage.pageNumber, imageUrl: firstImagePublicUrl },
      ...remainingResults,
    ];

    const storyWithImages = {
      ...story,
      pages: story.pages.map((page) => {
        const r = allResults.find((x) => x.pageNumber === page.pageNumber);
        return { ...page, imageUrl: r?.imageUrl || null };
      }),
    };

    return res.status(200).json(storyWithImages);
  } catch (err) {
    console.error('[generate-images]', err);
    return res.status(500).json({ error: err.message });
  }
}
