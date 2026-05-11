import React from 'react';
import { motion } from 'framer-motion';
import { Zap, ShieldCheck, Cpu } from 'lucide-react';

const features = [
  {
    title: "Efficiency",
    description: "Streamlined workflows designed to save time and reduce operational overhead.",
    icon: <Zap className="w-10 h-10 text-yellow-400" />,
    color: "bg-yellow-400/10"
  },
  {
    title: "Security",
    description: "Military-grade encryption and multi-factor authentication for your peace of mind.",
    icon: <ShieldCheck className="w-10 h-10 text-emerald-400" />,
    color: "bg-emerald-400/10"
  },
  {
    title: "Speed",
    description: "Built on lightning-fast infrastructure for near-instant response times.",
    icon: <Cpu className="w-10 h-10 text-blue-400" />,
    color: "bg-blue-400/10"
  }
];

const Features = () => {
  return (
    <section id="services" className="py-24 bg-[#030712]">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Core Capabilities</h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            Our portal is engineered to handle the most demanding administrative tasks with ease and precision.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              className="p-8 rounded-2xl glass hover:bg-white/[0.08] transition-all group"
            >
              <div className={`w-16 h-16 ${feature.color} rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                {feature.icon}
              </div>
              <h3 className="text-xl font-bold text-white mb-3">{feature.title}</h3>
              <p className="text-slate-400 leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
