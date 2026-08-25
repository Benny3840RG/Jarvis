import type {
  BusinessSettings,
  BusinessSettingsStore,
  BusinessSettingsUpdate,
} from "./businessSettings.js";
import { defaultBusinessSettings } from "./businessSettings.js";
import { applySettingsUpdate } from "./businessSettingsValidation.js";

function clone(settings: BusinessSettings): BusinessSettings {
  return {
    ...settings,
    contactDetails: { ...settings.contactDetails },
    paymentDetails: { ...settings.paymentDetails },
    pricing: { ...settings.pricing },
    numbering: { ...settings.numbering },
  };
}

export class InMemoryBusinessSettingsStore implements BusinessSettingsStore {
  private settings = defaultBusinessSettings();

  get(): Promise<BusinessSettings> {
    return Promise.resolve(clone(this.settings));
  }

  update(update: BusinessSettingsUpdate): Promise<BusinessSettings> {
    try {
      this.settings = applySettingsUpdate(this.settings, update);
      return Promise.resolve(clone(this.settings));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
