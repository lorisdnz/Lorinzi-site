import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';

// Leonardo Anime XL — ID vérifié fonctionnel
const MODEL_ID = '6b645e3a-d64f-4341-a6d8-7a3690fbf042';

// Style artistique verrouillé — identique pour tous les livres
const ART_STYLE =
  'beautiful children\'s book illustration, warm rich colors, ' +
  'detailed digital painting, soft rounded shapes, expressive characters with big eyes, ' +
  'warm golden lighting, gentle shading, professional storybook quality, ' +
  'consistent character design throughout the book';

async function generateWithLeonardo(apiKey, prompt, deadline) {
  const genRes = await fetch(`${LEONARDO_API}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      prompt,
      modelId:        MODEL_ID,
      width:          1024,
      height:         1024,
      num_images:     1,
      presetStyle:    'ILLUSTRATION',
      alchemy:        true,
      photoReal:      false,
      negative_prompt:
        'text, words, letters, watermark, blurry, deformed, ugly, ' +
        'multiple characters, different outfit, inconsistent character',
    }),
  });

  const genData      = await genRes.json();
  const generationId = genData.sdGenerationJob?.generationId;
  if (!generationId) {
    console.error('[images] Leonardo error:', JSON.stringify(genData));
    throw new Error('Leonardo: no generationId — ' + JSON.stringify(genData));
  }

  // Poll toutes les 3s — s'arrête si on approche la deadline Vercel
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));

    // Stop si on est à moins de 8s de la deadline
    if (deadline && Date.now() > deadline - 8000) {
      throw new Error('Leonardo: approaching deadline, aborting');
    }

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
  // upsert:true pour éviter les conflits si même filename
  const { error } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(buffer), { contentType: 'image/png', upsert: true });
  if (error) throw new Error('Supabase upload: ' + error.message);
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

    // GPT génère une description précise et fixe du personnage (temperature=0 = déterministe)
    const charRes = await openai.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0,
      max_tokens:  80,
      messages: [{
        role:    'user',
        content:
          `Create a precise, locked visual description for a children's book character. ` +
          `Character: ${age || 5}-year-old ${genderStr}. ` +
          (childDescription ? `Physical traits: ${childDescription}. ` : '') +
          `Specify: hair color and style, eye color, skin tone, ONE specific outfit ` +
          `(exact colors of shirt, pants/skirt, shoes) that NEVER changes. ` +
          `Max 50 words. English only. Be very specific about colors.`,
      }],
    });

    const characterDesc = charRes.choices[0].message.content.trim();
    console.log('[images] Character locked:', characterDesc);

    // Deadline = maintenant + 52s
    const deadline = Date.now() + 52000;

    // Générer par batch de 5 pages en parallèle (évite de surcharger Leonardo)
    const BATCH_SIZE = 5;
    const results    = [];

    for (let i = 0; i < story.pages.length; i += BATCH_SIZE) {
      // Stop si on approche la deadline
      if (Date.now() > deadline - 10000) {
        console.warn('[images] Deadline approaching, stopping at page', i);
        // Remplir le reste avec null
        for (let j = i; j < story.pages.length; j++) {
          results.push({ pageNumber: story.pages[j].pageNumber, imageUrl: null });
        }
        break;
      }

      const batch = story.pages.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (page) => {
          const prompt = [
            `${ART_STYLE}.`,
            `MAIN CHARACTER (always exactly the same in every image): ${characterDesc}.`,
            `SCENE: ${page.imagePrompt}.`,
            `No text, no letters, no words anywhere in the image.`,
          ].join(' ');

          try {
            const rawUrl    = await generateWithLeonardo(leonardoKey, prompt, deadline);
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
      results.push(...batchResults);
    }

    const ok = results.filter(r => r.imageUrl).length;
    console.log(`[images] ${ok}/${story.pages.length} images generated`);

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
