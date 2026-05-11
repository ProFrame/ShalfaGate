import React from 'react';
import { Mail, Phone, MapPin, Shield } from 'lucide-react';

const Footer = () => {
  return (
    <footer id="contact" className="py-16 border-t border-white/5 bg-[#020617]">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-2 mb-6">
              <Shield className="w-8 h-8 text-primary" />
              <span className="text-xl font-bold tracking-tight text-white">ShalfaGate</span>
            </div>
            <p className="text-slate-400 max-w-sm mb-6">
              Empowering organizations with secure, efficient, and intelligent portal solutions. 
              The future of administrative management starts here.
            </p>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6">Contact Us</h4>
            <ul className="space-y-4">
              <li className="flex items-center gap-3 text-slate-400">
                <Mail className="w-5 h-5 text-primary" />
                <span>support@shalfagate.com</span>
              </li>
              <li className="flex items-center gap-3 text-slate-400">
                <Phone className="w-5 h-5 text-primary" />
                <span>+966 12 345 6789</span>
              </li>
              <li className="flex items-center gap-3 text-slate-400">
                <MapPin className="w-5 h-5 text-primary" />
                <span>Riyadh, Saudi Arabia</span>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6">Company</h4>
            <ul className="space-y-4">
              <li><a href="#" className="text-slate-400 hover:text-white transition-colors">Privacy Policy</a></li>
              <li><a href="#" className="text-slate-400 hover:text-white transition-colors">Terms of Service</a></li>
              <li><a href="#" className="text-slate-400 hover:text-white transition-colors">Documentation</a></li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-white/5 flex flex-col md:row items-center justify-between gap-4 text-slate-500 text-sm">
          <p>© 2026 ShalfaGate. All rights reserved.</p>
          <div className="flex items-center gap-6">
            <a href="#" className="hover:text-white transition-colors">LinkedIn</a>
            <a href="#" className="hover:text-white transition-colors">Twitter</a>
            <a href="#" className="hover:text-white transition-colors">GitHub</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
