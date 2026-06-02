import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "LF Automatizador",
  description: "Manual de Usuario Oficial",
  
  head: [
    ['script', { type: 'text/javascript' }, `
      function googleTranslateElementInit() {
        new google.translate.TranslateElement({
          pageLanguage: 'es', 
          layout: google.translate.TranslateElement.InlineLayout.SIMPLE
        }, 'google_translate_element');
      }
      window.addEventListener('load', function() {
        var div = document.createElement('div');
        div.id = 'google_translate_element';
        div.style.position = 'fixed';
        div.style.bottom = '20px';
        div.style.right = '20px';
        div.style.zIndex = '9999';
        div.style.background = 'rgba(0,0,0,0.5)';
        div.style.padding = '5px';
        div.style.borderRadius = '5px';
        document.body.appendChild(div);
      });
    `],
    ['script', { src: '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit' }]
  ],

  locales: {
    root: {
      label: 'Español',
      lang: 'es-ES',
      themeConfig: {
        nav: [
          { text: 'Inicio', link: '/' },
          { text: 'Guía Rápida', link: '/guia/instalacion' }
        ],
        sidebar: [
          {
            text: 'Primeros Pasos',
            items: [
              { text: 'Sobre el Proyecto', link: '/guia/historia' },
              { text: 'Instalación', link: '/guia/instalacion' },
              { text: 'Conceptos Básicos', link: '/guia/conceptos' }
            ]
          },
          {
            text: 'Interfaz y Herramientas',
            items: [
              { text: 'La Interfaz Principal', link: '/guia/interfaz' },
              { text: 'Gestión de Biblioteca', link: '/guia/biblioteca' },
              { text: 'Editor de Pistas Avanzado', link: '/guia/editor-pistas' }
            ]
          },
          {
            text: 'Automatización',
            items: [
              { text: 'Eventos y Locuciones', link: '/guia/eventos' },
              { text: 'Emisión (Encoder)', link: '/guia/encoder' }
            ]
          }
        ],
        footer: {
          message: 'Desarrollado por Luis Fernando Velásquez',
          copyright: 'Copyright © 2026-presente LF Automatizador'
        }
      }
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Quick Start', link: '/en/guide/installation' }
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'About the Project', link: '/en/guide/history' },
              { text: 'Installation', link: '/en/guide/installation' }
            ]
          }
        ],
        footer: {
          message: 'Developed by Luis Fernando Velásquez',
          copyright: 'Copyright © 2026-present LF Automatizador'
        }
      }
    },
    pt: {
      label: 'Português (Brasil)',
      lang: 'pt-BR',
      link: '/pt/',
      themeConfig: {
        nav: [
          { text: 'Início', link: '/pt/' },
          { text: 'Guia Rápido', link: '/pt/guia/instalacao' }
        ],
        sidebar: [
          {
            text: 'Primeiros Passos',
            items: [
              { text: 'Sobre o Projeto', link: '/pt/guia/historia' },
              { text: 'Instalação', link: '/pt/guia/instalacao' }
            ]
          }
        ],
        footer: {
          message: 'Desenvolvido por Luis Fernando Velásquez',
          copyright: 'Copyright © 2026-presente LF Automatizador'
        }
      }
    },
    'pt-pt': {
      label: 'Português (Portugal)',
      lang: 'pt-PT',
      link: '/pt-pt/',
      themeConfig: {
        nav: [
          { text: 'Início', link: '/pt-pt/' },
          { text: 'Guia Rápido', link: '/pt-pt/guia/instalacao' }
        ],
        sidebar: [
          {
            text: 'Primeiros Passos',
            items: [
              { text: 'Sobre o Projeto', link: '/pt-pt/guia/historia' },
              { text: 'Instalação', link: '/pt-pt/guia/instalacao' }
            ]
          }
        ],
        footer: {
          message: 'Desenvolvido por Luis Fernando Velásquez',
          copyright: 'Copyright © 2026-presente LF Automatizador'
        }
      }
    }
  },
  
  themeConfig: {
    logo: '/icon.png',
    search: {
      provider: 'local'
    }
  }
})
