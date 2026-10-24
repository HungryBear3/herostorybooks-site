import ClassroomSignIn from './sign-in-form';
export const dynamic='force-dynamic';
export default function ClassroomSignInPage() {
  return <ClassroomSignIn enabled={process.env.HSB_CLASSROOM_AUTH_ENABLED==='true' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(process.env.HSB_CLASSROOM_SUPABASE_PUBLISHABLE_KEY || '')}/>;
}
