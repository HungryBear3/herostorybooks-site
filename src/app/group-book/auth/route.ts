import {handleClassroomAuth} from '@/lib/group-book/auth-handler';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(req:Request) {
  return handleClassroomAuth(req,{
    enabled:process.env.HSB_CLASSROOM_AUTH_ENABLED==='true',
    publishableKey:process.env.HSB_CLASSROOM_SUPABASE_PUBLISHABLE_KEY || '',
    secure:process.env.NODE_ENV==='production',
  });
}
