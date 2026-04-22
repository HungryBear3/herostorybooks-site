import Link from "next/link";
import Image from "next/image";

export function Footer() {
  return (
    <footer className="bg-navy text-cream py-16">
      <div className="container mx-auto px-6">
        <div className="grid md:grid-cols-4 gap-12 mb-12">
          {/* Logo and description */}
          <div className="md:col-span-2">
            <Link href="/" className="mb-4 inline-flex rounded-2xl bg-cream px-4 py-3 shadow-sm">
              <Image
                src="/assets/logo-horizontal-text.png"
                alt="HeroStoryBooks"
                width={220}
                height={56}
                className="h-10 w-auto"
              />
            </Link>
            <p className="text-cream/70 max-w-sm leading-relaxed">
              Creating magical, personalized storybooks that spark imagination and 
              become treasured keepsakes for families worldwide.
            </p>
          </div>

          {/* Quick links */}
          <div>
            <h4 className="font-serif font-semibold text-lg mb-4">Quick Links</h4>
            <ul className="space-y-2">
              <li>
                <Link href="#features" className="text-cream/70 hover:text-gold transition-colors">
                  Features
                </Link>
              </li>
              <li>
                <Link href="#pricing" className="text-cream/70 hover:text-gold transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="#faq" className="text-cream/70 hover:text-gold transition-colors">
                  FAQ
                </Link>
              </li>
              <li>
                <Link href="#" className="text-cream/70 hover:text-gold transition-colors">
                  Contact Us
                </Link>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="font-serif font-semibold text-lg mb-4">Legal</h4>
            <ul className="space-y-2">
              <li>
                <Link href="#" className="text-cream/70 hover:text-gold transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="#" className="text-cream/70 hover:text-gold transition-colors">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link href="#" className="text-cream/70 hover:text-gold transition-colors">
                  Shipping Policy
                </Link>
              </li>
              <li>
                <Link href="#" className="text-cream/70 hover:text-gold transition-colors">
                  Returns
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-cream/10 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-cream/50 text-sm">
            © {new Date().getFullYear()} HeroStoryBooks. All rights reserved.
          </p>
          <p className="text-cream/50 text-sm">
            Made with love for little heroes everywhere.
          </p>
        </div>
      </div>
    </footer>
  );
}
