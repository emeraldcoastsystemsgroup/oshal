/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial presentation engine — section-to-slide generation with template system
 */

import { createChildLogger } from '@/shared/logger';
import type {
  PresentationRequest,
  PresentationResult,
  PresentationSection,
  GeneratedSlide,
  SlideTemplate,
} from '@/shared/types';

const logger = createChildLogger({ module: 'presentation-engine' });

/**
 * @description Presentation generation engine that converts structured sections into slides.
 * Supports multiple templates and output formats.
 */
export class PresentationEngine {
  private templates: Map<string, SlideTemplate> = new Map();

  constructor() {
    this.initializeTemplates();
  }

  /**
   * @description Main generation function — converts request sections into a slide deck.
   * @param request - The presentation generation request
   * @returns Generated presentation result with slides
   */
  async generate(request: PresentationRequest): Promise<PresentationResult> {
    logger.info(
      { title: request.title, sectionCount: request.sections.length },
      'Starting presentation generation',
    );

    const templateId = request.templateId || 'default';
    const template = this.templates.get(templateId);

    if (!template) {
      logger.warn({ templateId }, 'Template not found, using default');
    }

    const slides = this.generateSlides(request.sections);
    const format = request.format || 'html';

    const result: PresentationResult = {
      id: this.generateId(),
      title: request.title,
      slides,
      createdAt: new Date().toISOString(),
      format,
    };

    logger.info(
      { id: result.id, slideCount: slides.length },
      'Presentation generation complete',
    );

    return result;
  }

  /**
   * @description Converts a sections array into generated slides.
   * @param sections - Ordered presentation sections
   * @returns Array of generated slides
   */
  private generateSlides(sections: PresentationSection[]): GeneratedSlide[] {
    return sections.map((section, index) => ({
      index: index + 1,
      title: section.title,
      content: section.content,
      type: section.type || 'content',
      notes: section.notes,
    }));
  }

  /**
   * @description Initializes built-in slide templates.
   */
  private initializeTemplates(): void {
    const builtInTemplates: SlideTemplate[] = [
      { id: 'default', name: 'Default Template', layout: 'standard' },
      { id: 'executive', name: 'Executive Summary', layout: 'minimal' },
      { id: 'technical', name: 'Technical Deep Dive', layout: 'detailed' },
    ];

    for (const tmpl of builtInTemplates) {
      this.templates.set(tmpl.id, tmpl);
    }

    logger.debug({ templateCount: this.templates.size }, 'Templates initialized');
  }

  /**
   * @description Generates a unique presentation ID.
   * @returns Unique ID string
   */
  private generateId(): string {
    return `pres-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }
}