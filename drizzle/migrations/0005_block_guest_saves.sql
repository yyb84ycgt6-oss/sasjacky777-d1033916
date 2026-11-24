DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_usage_logs','bot_api_keys','chat_attachments','chat_messages',
    'conversation_tag_links','conversation_tags','conversations',
    'eye_pod_registry','game_design_entries','game_projects',
    'game_purchase_locks','game_saves','game_transactions',
    'gunit_agents','gunit_bots','gunit_improvements','gunit_memory',
    'jackie_control_audit','jackie_control_prefs','jackie_control_swarms',
    'jackie_core_docs','jackie_custom_tools','jackie_memory','jackie_skills',
    'jackie_tasks','mesh_jobs','mesh_routers','pod_folds',
    'provider_usage_events','user_bots','xai_generation_requests'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((auth.jwt() ->> ''is_anonymous'') IS DISTINCT FROM ''true'') WITH CHECK ((auth.jwt() ->> ''is_anonymous'') IS DISTINCT FROM ''true'')',
      t || '_no_guest_access', t
    );
  END LOOP;
END $$;