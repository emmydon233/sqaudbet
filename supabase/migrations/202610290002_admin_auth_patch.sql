CREATE OR REPLACE FUNCTION public.assert_squadbet_admin(p_admin uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = p_admin
      AND u.raw_app_meta_data ->> 'role' = 'admin'
  ) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_squadbet_admin(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_squadbet_admin(uuid)
  TO service_role;

