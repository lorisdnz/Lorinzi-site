import { createClient } from '@supabase/supabase-js';

// Endpoint de diagnostic — GET /api/debug
// Vérifie toutes les config et teste les connexions
export default async function handler(req, res) {
  const report = {};

  // 1. Variables d'environnement
  report.env = {
    OPENAI_API_KEY:           !!process.env.OPENAI_API_KEY,
    LEONARDO_API_KEY:         !!process.env.LEONARDO_API_KEY,
    PUBLIC_SUPABASE_URL:      !!process.env.PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY:!!process.env.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY:        !!process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET:    !!process.env.STRIPE_WEBHOOK_SECRET,
    RESEND_API_KEY:           !!process.env.RESEND_API_KEY,
    GELATO_API_KEY:           !!process.env.GELATO_API_KEY,
  };

  // 2. Test Supabase connexion + buckets
  try {
    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) {
      report.supabase = { ok: false, error: error.message };
    } else {
      const bucketNames = buckets.map(b => b.name);
      report.supabase = {
        ok: true,
        buckets: bucketNames,
        has_images_bucket: bucketNames.includes('images'),
        has_pdfs_bucket:   bucketNames.includes('pdfs'),
      };

      // Test: lister les 3 dernières images
      if (bucketNames.includes('images')) {
        const { data: files } = await supabase.storage.from('images').list('', { limit: 3, sortBy: { column: 'created_at', order: 'desc' } });
        report.supabase.last_images = files?.map(f => f.name) || [];
      }

      // Test: lire la dernière commande
      const { data: orders } = await supabase.from('orders').select('id, status, created_at').order('created_at', { ascending: false }).limit(3);
      report.supabase.last_orders = orders?.map(o => ({ id: o.id.slice(0,8), status: o.status, date: o.created_at })) || [];
    }
  } catch (e) {
    report.supabase = { ok: false, error: e.message };
  }

  // 3. Test Leonardo API key
  try {
    const r = await fetch('https://cloud.leonardo.ai/api/rest/v1/me', {
      headers: { 'Authorization': `Bearer ${process.env.LEONARDO_API_KEY}` },
    });
    const data = await r.json();
    report.leonardo = {
      ok: r.ok,
      status: r.status,
      user: data?.user_details?.[0]?.user?.username || null,
      token_renewals: data?.user_details?.[0]?.subscriptionTokens || null,
    };
  } catch (e) {
    report.leonardo = { ok: false, error: e.message };
  }

  // 4. Test OpenAI API key
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    report.openai = { ok: r.ok, status: r.status };
  } catch (e) {
    report.openai = { ok: false, error: e.message };
  }

  return res.status(200).json(report);
}
