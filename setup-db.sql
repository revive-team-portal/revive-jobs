-- ============================================================
-- REVIVE CAFE JOBS - Supabase Database Setup
-- Run this entire script in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('full_time', 'part_time', 'casual', 'fixed_term')),
  description TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'expired')),
  expiry_date DATE,
  employer_name TEXT,
  employer_email TEXT,
  views INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  location TEXT,
  cover_letter TEXT,
  resume_url TEXT,
  resume_filename TEXT,
  cover_letter_url TEXT,
  cover_letter_filename TEXT,
  referral_source TEXT CHECK (referral_source IN ('seek','facebook','friend','backpacker_board','sis','not_sure','other')),
  on_visa BOOLEAN DEFAULT false,
  visa_type TEXT,
  visa_country TEXT,
  visa_expiry DATE,
  visa_conditions TEXT,
  status TEXT DEFAULT 'new' CHECK (status IN ('new','not_suitable','shortlist_a','shortlist_b','interview','hired','not_hired')),
  suitability_score INTEGER CHECK (suitability_score BETWEEN 1 AND 10),
  ai_score INTEGER CHECK (ai_score BETWEEN 1 AND 10),
  previous_employers TEXT,
  ai_analysis_notes TEXT,
  interview_token UUID DEFAULT gen_random_uuid() UNIQUE,
  interview_slot_id UUID,
  interview_notes TEXT,
  interview_notes_employer TEXT,
  interview_invite_sent BOOLEAN DEFAULT false,
  interview_invite_sent_at TIMESTAMPTZ,
  medical_issues TEXT,
  days_unavailable TEXT,
  start_date DATE,
  upcoming_holidays TEXT,
  declarations_agreed BOOLEAN DEFAULT false,
  extended_form_completed BOOLEAN DEFAULT false,
  rejection_sent BOOLEAN DEFAULT false,
  rejection_sent_at TIMESTAMPTZ,
  confirmation_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interview_slots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  slot_time TIMESTAMPTZ NOT NULL,
  is_booked BOOLEAN DEFAULT false,
  application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE applications
  ADD CONSTRAINT fk_interview_slot
  FOREIGN KEY (interview_slot_id) REFERENCES interview_slots(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS job_views (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  referral_source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gallery_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  url TEXT NOT NULL,
  filename TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_interview_token ON applications(interview_token);
CREATE INDEX IF NOT EXISTS idx_interview_slots_job_id ON interview_slots(job_id);
CREATE INDEX IF NOT EXISTS idx_job_views_job_id ON job_views(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER applications_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_photos ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------
-- JOBS
-- Public: read active jobs only
-- Admin: full access
-- ----------------------------------------------------------------
CREATE POLICY "Public can view active jobs" ON jobs
  FOR SELECT USING (status = 'active');

CREATE POLICY "Admin full access to jobs" ON jobs
  FOR ALL USING (auth.role() = 'authenticated');

-- ----------------------------------------------------------------
-- APPLICATIONS
-- Public: INSERT only (submit an application)
-- NO public SELECT or UPDATE — all reads/writes go via
-- Netlify server-side functions using the service role key
-- Admin: full access via authenticated session
-- ----------------------------------------------------------------
CREATE POLICY "Public can submit applications" ON applications
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin full access to applications" ON applications
  FOR ALL USING (auth.role() = 'authenticated');

-- ----------------------------------------------------------------
-- INTERVIEW SLOTS
-- Public: read available slots (non-sensitive — just times)
-- Admin: full access
-- Writes (booking) handled server-side via complete-interview function
-- ----------------------------------------------------------------
CREATE POLICY "Public can view interview slots" ON interview_slots
  FOR SELECT USING (true);

CREATE POLICY "Admin full access to interview slots" ON interview_slots
  FOR ALL USING (auth.role() = 'authenticated');

-- ----------------------------------------------------------------
-- JOB VIEWS
-- Public: insert (track clicks)
-- Admin: read
-- ----------------------------------------------------------------
CREATE POLICY "Public can insert job views" ON job_views
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin can read job views" ON job_views
  FOR SELECT USING (auth.role() = 'authenticated');

-- ----------------------------------------------------------------
-- SETTINGS
-- Public: read (needed for public pages — company info, benefits)
-- Admin: full access
-- ----------------------------------------------------------------
CREATE POLICY "Public can read settings" ON settings
  FOR SELECT USING (true);

CREATE POLICY "Admin full access to settings" ON settings
  FOR ALL USING (auth.role() = 'authenticated');

-- ----------------------------------------------------------------
-- GALLERY PHOTOS
-- Public: read (shown on public jobs page)
-- Admin: full access
-- ----------------------------------------------------------------
CREATE POLICY "Public can view gallery photos" ON gallery_photos
  FOR SELECT USING (true);

CREATE POLICY "Admin full access to gallery" ON gallery_photos
  FOR ALL USING (auth.role() = 'authenticated');

-- ============================================================
-- DEFAULT SETTINGS
-- ============================================================

INSERT INTO settings (key, value) VALUES
(
  'company_history',
  'Revive Cafe was founded in 2007 with a simple mission: to make delicious, healthy plant-based food accessible to everyone in Auckland and beyond.

What started as a small downtown cafe has grown into one of New Zealand''s most loved healthy food brands — with a thriving cafe, an award-winning range of Heat & Eat meals, cookbooks, nut butters, mueslis and pantry products shipped around the country.

Our team is the heart of everything we do. We believe in creating a warm, supportive workplace where people grow, feel valued, and genuinely love what they do. If you share our passion for healthy food and great customer experiences, we''d love to hear from you.'
),
(
  'company_benefits',
  'Free healthy meals and snacks on every shift
Friendly, supportive team culture
Flexible rostering where possible
Staff discounts on all Revive products
Career development and progression opportunities
Central Auckland location, easy to get to
Be part of a purpose-driven, values-led business
Regular team events and get-togethers'
),
(
  'email_confirmation_subject',
  'Thank you for applying — {{job_title}} at Revive Cafe'
),
(
  'email_confirmation_body',
  'Hi {{applicant_name}},

Thank you so much for applying for the {{job_title}} position at Revive Cafe. We have received your application and really appreciate you taking the time to apply.

Here''s a summary of what you submitted:

---
POSITION APPLIED FOR: {{job_title}} ({{job_type}})
NAME: {{applicant_name}}
EMAIL: {{applicant_email}}
PHONE: {{applicant_phone}}
LOCATION: {{applicant_location}}
HOW YOU HEARD ABOUT US: {{referral_source}}
{{visa_info}}
---

ABOUT REVIVE CAFE
{{company_history}}

WHY WORK WITH US
{{company_benefits}}

---

Please note: Due to the volume of applications we receive, we are unable to respond to each applicant individually. If you have not heard from us within two weeks of applying, please consider your application unsuccessful at this time.

We wish you all the best in your job search.

Warm regards,
The Revive Cafe Team
jobs@revivealicious.com'
),
(
  'email_interview_subject',
  'Interview Invitation — {{job_title}} at Revive Cafe'
),
(
  'email_interview_body',
  'Hi {{applicant_name}},

Congratulations! We were impressed with your application for the {{job_title}} position and would love to invite you for an interview.

TO CONFIRM YOUR INTERVIEW:
Please click the link below to select your preferred interview time and complete a short additional application form:

{{interview_link}}

Please complete this within 48 hours to secure your spot.

---
ABOUT THE ROLE: {{job_title}} ({{job_type}})
{{job_description_summary}}

ABOUT REVIVE CAFE
{{company_history}}

WHY WORK WITH US
{{company_benefits}}
---

We look forward to meeting you!

Warm regards,
{{employer_name}}
Revive Cafe
jobs@revivealicious.com'
),
(
  'email_rejection_subject',
  'Your application to Revive Cafe — {{job_title}}'
),
(
  'email_rejection_body',
  'Hi {{applicant_name}},

Thank you for taking the time to apply for the {{job_title}} position at Revive Cafe.

After careful consideration, we have decided to progress with other candidates at this time. We genuinely appreciate your interest in joining our team and wish you all the best in your job search.

Please feel free to apply for future roles — we regularly post new opportunities.

Warm regards,
The Revive Cafe Team'
),
(
  'email_interview_confirmation_subject',
  'Interview Confirmed — {{job_title}} at Revive Cafe'
),
(
  'email_interview_confirmation_body',
  'Hi {{applicant_name}},

Your interview has been confirmed! Here are the details:

INTERVIEW TIME: {{interview_time}}
POSITION: {{job_title}}
LOCATION: Revive Cafe, Auckland CBD

Please arrive a few minutes early. If you need to reschedule, please contact us at jobs@revivealicious.com as soon as possible.

We look forward to meeting you!

Warm regards,
{{employer_name}}
Revive Cafe'
),
(
  'interview_form_questions',
  'Do you have any medical conditions or physical limitations that may affect your ability to perform this role?
Which days of the week are you NOT available to work?
What is the earliest date you could start work?
Do you have any holidays or travel planned in the next 3 months? If so, please provide dates.'
),
(
  'declarations_text',
  'I declare that all information provided in this application is true, complete and accurate to the best of my knowledge.
I understand that providing false or misleading information may result in my application being declined or, if employed, in termination of employment.
I consent to Revive Cafe contacting my previous employers and referees to verify the information provided.
I understand that any offer of employment is subject to satisfactory reference and background checks.'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- STORAGE BUCKETS
-- ============================================================

INSERT INTO storage.buckets (id, name, public) VALUES ('gallery', 'gallery', true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('resumes', 'resumes', false) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('cover-letters', 'cover-letters', false) ON CONFLICT DO NOTHING;

-- Gallery: public read, admin write
CREATE POLICY "Public can view gallery images" ON storage.objects
  FOR SELECT USING (bucket_id = 'gallery');

CREATE POLICY "Admin can upload gallery images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'gallery' AND auth.role() = 'authenticated');

CREATE POLICY "Admin can delete gallery images" ON storage.objects
  FOR DELETE USING (bucket_id = 'gallery' AND auth.role() = 'authenticated');

-- Resumes: anyone can upload (applicants), only admin can read
CREATE POLICY "Anyone can upload resumes" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'resumes');

CREATE POLICY "Admin can read resumes" ON storage.objects
  FOR SELECT USING (bucket_id = 'resumes' AND auth.role() = 'authenticated');

-- Cover letters: anyone can upload, only admin can read
CREATE POLICY "Anyone can upload cover letters" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'cover-letters');

CREATE POLICY "Admin can read cover letters" ON storage.objects
  FOR SELECT USING (bucket_id = 'cover-letters' AND auth.role() = 'authenticated');

-- ============================================================
-- CREATE ADMIN USER
-- Go to: Authentication > Users > Add User
-- Email: jobs@revivealicious.com
-- Password: Blue1234!
-- ============================================================

SELECT 'Revive Cafe Jobs database setup complete!' AS status;
