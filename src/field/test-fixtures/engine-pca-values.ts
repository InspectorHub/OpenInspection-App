/** Values extracted from the engine's own source (pca-narrative, pca-reliance-text, commercial-subtypes). Not authored here. */
export const ENGINE_PCA_VALUES = {
  "pcaNarrativeSeed": {
    "transmittalLetter": "This Property Condition Report has been prepared at your request and in accordance with the agreed scope of work. The accompanying report presents our observations, opinions of cost, and recommendations based on a walk-through survey of the subject property.",
    "summaryGeneralDescription": "The subject property consists of the improvements identified in the General Property Description. This summary states the property facts, the consultant and user, their relationship, the transaction, the purpose of this assessment, and the date of the site visit.",
    "summaryPhysicalCondition": "In our opinion, the property is in generally average condition for its age and use, with the material physical deficiencies and recommended actions noted in the body of this report.",
    "summaryRecommendations": "We recommend addressing the material physical deficiencies identified herein. Where specialist evaluation is warranted, follow-up assessments are referenced in the appendices.",
    "purpose": "The purpose of this assessment is to observe and document the physical condition of the property in support of the user’s position in the contemplated transaction.",
    "scopeOfWork": "The scope of work comprised a walk-through survey of the readily accessible areas of the improvements, review of available documents, and interviews where practicable. The methods used are described in this section; no destructive or invasive testing was performed.",
    "limitationsExceptions": "This assessment was limited to readily accessible areas observed at the time of the site visit. Concealed conditions, components not in service, and areas not made available were not evaluated. The observations represent the conditions existing on the date of the survey only.",
    "reconnaissance": "A general reconnaissance of the property and its immediate surroundings was performed to observe site conditions, access, and the relationship of the improvements to adjacent uses.",
    "additionalConsiderations": "The following considerations are outside the baseline scope of this assessment and are provided for the user’s information only: natural hazards, mold, and accessibility (ADA) are not assessed unless a separate add-on scope was engaged."
  },
  "relianceTemplates": {
    "userReliance": "This Property Condition Report has been prepared for the exclusive use and reliance of the named User and its designated representatives in connection with the identified transaction. No other party may rely on this report without the prior written authorization of the Consultant.",
    "pointInTime": "The observations and opinions in this report describe the condition of the subject property as of the date of the site visit. Property conditions may change after that date; the Consultant assumes no obligation to update the report to reflect events or conditions arising after the site visit.",
    "siteSpecific": "This report is specific to the subject property and the scope of work agreed with the User. It is not a comprehensive engineering study, code-compliance survey, or warranty of the property, and it should be read together with the Limitations & Exceptions stated herein."
  },
  "commercialPresetFieldIds": {
    "commercial:office": [
      "yearBuilt",
      "nra",
      "floorCount",
      "occupancyClass",
      "sprinklered",
      "lastRenovation"
    ],
    "commercial:retail": [
      "yearBuilt",
      "gla",
      "storefrontCount",
      "anchorTenant",
      "parkingSpaces"
    ],
    "commercial:hospitality": [
      "yearBuilt",
      "roomCount",
      "brandAffiliation",
      "aaaRating",
      "lastRenovation"
    ],
    "commercial:industrial": [
      "yearBuilt",
      "sqft",
      "clearHeight",
      "dockCount",
      "powerCapacity",
      "railSpur"
    ],
    "commercial:institutional": [
      "yearBuilt",
      "sqft",
      "occupancyType",
      "sprinklered"
    ],
    "commercial:mixed-use": [
      "yearBuilt",
      "residentialUnits",
      "commercialSqft"
    ]
  }
} as const;
