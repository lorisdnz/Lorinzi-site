import OpenAI from 'openai';

function buildPrompt(data) {
  const pageCount = data.bookFormat === 'court' ? 14 : data.bookFormat === 'classique' ? 20 : 25;
  const styleMap = {
    magique: 'magique et féerique, plein de créatures enchanteresses',
    aventure: "d'aventure et d'exploration avec des défis à surmonter",
    quotidien: 'tendre et ancré dans le quotidien',
    educatif: 'éducatif et bienveillant',
    surprise: 'surprenant et original',
  };

  const childAppearance = [data.skinColor, data.eyeColor, data.hairColor].filter(Boolean).join(', ');
  const petAppearance = data.petColor ? `couleur : ${data.petColor}` : '';
  const personAppearance = [data.personSkinColor, data.personEyeColor, data.personHairColor].filter(Boolean).join(', ');

  return `Tu es un auteur de livres pour enfants. Crée une histoire personnalisée en français.

INFORMATIONS SUR L'ENFANT :
- Prénom : ${data.childFirstName}${data.nickname ? ` (surnom : "${data.nickname}")` : ''}
- Genre : ${data.gender}
- Âge : ${data.age} ans
- Caractère : ${data.personality}${childAppearance ? `\n- Apparence : ${childAppearance}` : ''}
- Ce qu'il/elle aime : ${(data.hobbies || []).join(', ')}${data.hobbiesOther ? `, ${data.hobbiesOther}` : ''}
${data.hasPet && data.petName ? `- Animal de compagnie : ${data.petName} (${data.petSpecies}${petAppearance ? ', ' + petAppearance : ''})` : ''}
${data.importantPeople ? `- Personnages à inclure : ${data.importantPeople}${personAppearance ? ` (apparence : ${personAppearance})` : ''}` : ''}
- Lieu de l'histoire : ${data.storySetting}

COHÉRENCE VISUELLE — RÈGLE ABSOLUE :
Choisis UNE SEULE tenue pour le personnage principal sur la page 1 et ne la change JAMAIS jusqu'à la dernière page. Même chemise, même pantalon/jupe, mêmes chaussures, même coiffure, même couleur de peau dans chaque imagePrompt sans exception.${childAppearance ? `\nApparence physique fixe : ${childAppearance}.` : ''}

Dans CHAQUE imagePrompt tu dois inclure EXACTEMENT :
1. "[Character: {prénom}, {age}-year-old {gender}, {description physique complète}, wearing {tenue IDENTIQUE à toutes les pages}]"
2. "[Style: high quality children's book illustration, rich vibrant colors, detailed digital painting, expressive cartoon characters with big eyes, warm cheerful lighting, soft shading and depth, professional storybook quality, same character design as ALL other pages]"
3. "[Scene: {description de la scène de cette page}]"
4. "[No text, no letters, no words in the image]"

STYLE : Histoire de type ${styleMap[data.storyStyle] || 'magique'}.
${data.includeEducationalMessage && data.educationalTheme ? `MESSAGE ÉDUCATIF : Intègre subtilement : ${data.educationalTheme}.` : ''}

FORMAT :
- Exactement ${pageCount} pages.
- 50 à 70 mots par page maximum, adaptés à ${data.age} ans. Phrases courtes et simples.
- Retourne uniquement du JSON valide :

{
  "title": "Titre de l'histoire",
  "pages": [
    {
      "pageNumber": 1,
      "text": "Texte de la page...",
      "imagePrompt": "Soft watercolor children's book illustration. [Character: full physical description + exact outfit]. [Scene description]. Warm pastel colors, rounded gentle shapes, consistent style."
    }
  ]
}`.trim();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;

    if (!data.childFirstName || !data.gender || !data.age || !data.storyStyle) {
      return res.status(400).json({ error: 'Données du formulaire incomplètes' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: buildPrompt(data) }],
      response_format: { type: 'json_object' },
      temperature: 0.85,
    });

    const story = JSON.parse(completion.choices[0].message.content);
    return res.status(200).json(story);
  } catch (err) {
    console.error('[generate-story]', err);
    return res.status(500).json({ error: err.message });
  }
}
