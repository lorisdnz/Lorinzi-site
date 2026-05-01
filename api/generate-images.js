import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';
// Leonardo Phoenix — meilleur modèle pour la cohérence visuelle
const MODEL_ID = 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3';

// Style artistique fixe — identique pour TOUS les livres
const ART_STYLE =
  'beautiful children\'s book illustration, warm rich colors, ' +
  'detailed digital painting, soft rounded shapes, expressive characters with big eyes, ' +
  'warm golden lighting, gentle shading, professional storybook quality, ' +
  'Pixar-inspired style, consistent character throughout the book';

async function generateWithLeonardo(apiKey, prompt) {
  const genRes = await fetch(`${LEONARDO_API}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      prompt,
      modelId:     MODEL_ID,
      width:       1024,
      height:      1024,
      num_images:  1,
      presetStyle: 'ILLUSTRATION',
      alchemy:     true,
      photoReal:   false,
      // negative prompt — évite les incohérences visuelles
      negative_prompt:
        'text, words, letters, watermark, blurry, deformed, extra limbs, ' +
        'multiple characters, different outfit, different hair, inconsistent character',
    }),
  });

  const genData      = await genRes.json();
  const generationId = genData.sdGenerationJob?.generationId;
  if (!generationId) throw new Error('Leonardo: no generationId — ' + JSON.stringify(genData));

  // Poll toutes les 2s — max 30 fois = 60 secondes
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`${LEONARDO_API}/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await poll.json();
    const gen  = data.generations_by_pk;
    if (gen?.status === 'COMPLETE') {
      const url = gen.generated_images?.[0]?.url;
      if (!url) throw new Error('Leonardo: no image URL');
      return url;
    }
    if (gen?.status === 'FAILED') throw new Error('Leonardo: generation failed');
  }
  throw new Error('Leonardo: timeout');
}

async function uploadToSupabase(supabase, imageUrl, filename) {
  const res    = await fetch(imageUrl);
  const buffer = await res.arrayBuffer();
  const { error } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(buffer), { contentType: 'image/png' });
  if (error) throw new Error(error.message);
  const { data: { publicUrl } } = supabase.storage.from('images').getPublicUrl(filename);
  return publicUrl;
}

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

    // GPT génère une description très précise et verrouillée du personnage
    // Temperature 0 = déterministe, résultat identique à chaque appel pour le même enfant
    const charRes = await openai.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0,
      max_tokens:  80,
      messages: [{
        role:    'user',
        content:
          `Create a precise, locked character description for a children's book illustration series. ` +
          `Character: ${age || 5}-year-old ${genderStr}. ` +
          (childDescription ? `Physical traits provided: ${childDescription}. ` : '') +
          `Specify EXACTLY: hair color and style, eye color, skin tone, ONE specific outfit ` +
          `(color of shirt, pants/skirt, shoes) that will NEVER change across all illustrations. ` +
          `Max 50 words. English only. Format: "[name] is a [age]-year-old [gender] with [hair], ` +
          `[eyes], [skin]. Always wearing [exact outfit]."`,
      }],
    });

    const characterDesc = charRes.choices[0].message.content.trim();
    console.log('[images] Character locked:', characterDesc);

    // Générer toutes les images en parallèle
    const results = await Promise.all(
      story.pages.map(async (page) => {
        // Prompt structuré en 3 blocs pour maximiser la cohérence Phoenix
        const prompt = [
          // 1. Style artistique global
          `${ART_STYLE}.`,
          // 2. Description du personnage — IDENTIQUE sur chaque page
          `MAIN CHARACTER (always exactly the same): ${characterDesc}.`,
          // 3. Scène spécifique à cette page
          `SCENE: ${page.imagePrompt}.`,
          // 4. Règles absolues
          `No text, no letters, no words anywhere in the image. Single main character only.`,
        ].join(' ');

        try {
          const rawUrl    = await generateWithLeonardo(leonardoKey, prompt);
          const filename  = `p${page.pageNumber}-${Date.now()}.png`;
          const publicUrl = await uploadToSupabase(supabase, rawUrl, filename);
          console.log(`[images] Page ${page.pageNumber} ✓`);
          return { pageNumber: page.pageNumber, imageUrl: publicUrl };
        } catch (err) {
          console.error(`[images] Page ${page.pageNumber} ✗:`, err.message);
          return { pageNumber: page.pageNumber, imageUrl: null };
        }
      })
    );

    const ok = results.filter(r => r.imageUrl).length;
    console.log(`[images] ${ok}/${story.pages.length} generated`);

    return res.status(200).json({
      ...story,
      pages: story.pages.map(page => {
        const r = results.find(x => x.pageNumber === page.pageNumber);
        return { ...page, imageUrl: r?.imageUrl || null };
      }),
    });

  } catch (err) {
    console.error('[images]', err);
    return res.status(500).json({ error: err.message });
  }
}
