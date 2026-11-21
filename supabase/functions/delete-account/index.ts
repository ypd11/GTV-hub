// Supabase Edge Function: delete-account
// Deploy with: supabase functions deploy delete-account
// Keep SUPABASE_SERVICE_ROLE_KEY configured as a server-side secret only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authorization = req.headers.get("Authorization");
    const accessToken = authorization?.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "You must be signed in to delete your account." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Account deletion is not configured on the server.");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Validate the caller's access token before using the service-role client.
    const { data: { user }, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Your session is invalid or has expired. Please sign in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Deleting auth.users triggers the account's configured ON DELETE CASCADE
    // relationships, including community profiles, activity, follows, and
    // account-owned viewing profiles/profile data.
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("delete-account failed:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Account deletion failed." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
