CREATE POLICY jackie_core_access_no_guest_access
  ON public.jackie_core_access
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'is_anonymous') IS DISTINCT FROM 'true')
  WITH CHECK ((auth.jwt() ->> 'is_anonymous') IS DISTINCT FROM 'true');

CREATE POLICY user_roles_no_guest_access
  ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'is_anonymous') IS DISTINCT FROM 'true')
  WITH CHECK ((auth.jwt() ->> 'is_anonymous') IS DISTINCT FROM 'true');