(function () {
  const url = window.SUPABASE_URL;
  const anonKey = window.SUPABASE_ANON_KEY;
  const hasConfig = Boolean(
    url &&
    anonKey &&
    !url.includes('YOUR_PROJECT_REF') &&
    !anonKey.includes('YOUR_SUPABASE_')
  );

  let client = null;
  let configError = null;

  if (hasConfig && window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(url, anonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
      }
    });
  } else if (!hasConfig) {
    configError = 'Configurez SUPABASE_URL et SUPABASE_ANON_KEY dans assets/js/supabase-config.js.';
  } else {
    configError = 'Le SDK Supabase n’a pas été chargé. Vérifiez votre connexion internet.';
  }

  function requireClient() {
    if (!client) {
      return { error: { message: configError } };
    }
    return null;
  }

  window.supabaseClient = client;
  window.mcaAuth = {
    isConfigured() {
      return Boolean(client);
    },

    getConfigError() {
      return configError;
    },

    async signUp({ email, password, options }) {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.signUp({ email, password, options });
    },

    async ensureProfile({ id, email, role = 'client', createdAt = null }) {
      const unavailable = requireClient();
      if (unavailable) {
        console.error('[mcaAuth.ensureProfile] client unavailable', unavailable.error);
        return { ok: false, exists: false, error: unavailable.error, reason: 'client_unavailable' };
      }

      if (!id) {
        const error = { message: 'ID utilisateur manquant pour créer le profil.' };
        console.error('[mcaAuth.ensureProfile] missing user data', { id, email, role, createdAt });
        return { ok: false, exists: false, error, reason: 'missing_user_data' };
      }

      const payload = {
        id,
        role,
        created_at: createdAt || new Date().toISOString()
      };

      console.log('[mcaAuth.ensureProfile] start', { id, email, role, createdAt, payload });

      try {
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (sessionError) {
          console.error('[mcaAuth.ensureProfile] getSession failed', sessionError);
          return { ok: false, exists: false, error: sessionError, reason: 'session_error' };
        }

        if (!sessionData?.session) {
          console.warn('[mcaAuth.ensureProfile] no active session; browser cannot verify profils table because RLS/session is not available. The DB trigger should have created the row.', {
            id,
            email,
            role,
            createdAt
          });
          return {
            ok: true,
            exists: true,
            error: null,
            reason: 'trigger_created_without_session'
          };
        }

        console.log('[mcaAuth.ensureProfile] checking table profils for id', id);
        const { data: existingProfile, error: selectError } = await client
          .from('profils')
          .select('id, role, created_at')
          .eq('id', id)
          .maybeSingle();

        console.log('[mcaAuth.ensureProfile] select result', { existingProfile, selectError });

        if (selectError) {
          console.error('[mcaAuth.ensureProfile] select failed', selectError);
          return { ok: false, exists: false, error: selectError, reason: 'select_error' };
        }

        if (existingProfile) {
          console.log('[mcaAuth.ensureProfile] profile already exists in profils', existingProfile);
          return { ok: true, exists: true, data: existingProfile, error: null, reason: 'already_exists' };
        }

        console.log('[mcaAuth.ensureProfile] no profile found, inserting into profils', payload);
        const { data: insertedProfile, error: insertError } = await client
          .from('profils')
          .insert([payload])
          .select('id, role, created_at')
          .single();

        console.log('[mcaAuth.ensureProfile] insert result', { insertedProfile, insertError });

        if (insertError) {
          console.error('[mcaAuth.ensureProfile] insert failed', insertError);
          return { ok: false, exists: false, error: insertError, reason: 'insert_error' };
        }

        console.log('[mcaAuth.ensureProfile] profile created successfully', insertedProfile);
        return { ok: true, exists: true, data: insertedProfile, error: null, reason: 'inserted' };
      } catch (err) {
        console.error('[mcaAuth.ensureProfile] unexpected exception', err);
        return {
          ok: false,
          exists: false,
          error: { message: err?.message || 'Erreur inconnue lors de la création du profil.' },
          reason: 'unexpected_error'
        };
      }
    },

    async signInWithPassword({ email, password }) {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.signInWithPassword({ email, password });
    },

    async signOut() {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.signOut();
    },

    async resetPasswordForEmail(email) {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, 'login.html')}?recovery=1`
      });
    },

    async updatePassword(password) {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.updateUser({ password });
    },

    async getUser() {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.getUser();
    },

    async getSession() {
      const unavailable = requireClient();
      if (unavailable) return unavailable;
      return client.auth.getSession();
    }
  };
})();
