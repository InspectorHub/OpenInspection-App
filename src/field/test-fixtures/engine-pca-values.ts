/** Values extracted from the engine's own source (pca-narrative, pca-reliance-text, commercial-subtypes) by script. Not authored here. */
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
  "commercialPresets": {
    "commercial:office": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "nra",
        "label": "Net rentable area",
        "type": "number",
        "unit": "sqft",
        "group": "physical",
        "required": true
      },
      {
        "id": "floorCount",
        "label": "Number of floors",
        "type": "number",
        "group": "physical"
      },
      {
        "id": "occupancyClass",
        "label": "Occupancy classification",
        "type": "select",
        "group": "compliance",
        "options": [
          "B (Business)",
          "A-3 (Assembly)",
          "M (Mercantile)",
          "Other"
        ]
      },
      {
        "id": "sprinklered",
        "label": "Sprinklered",
        "type": "select",
        "group": "compliance",
        "options": [
          "Full",
          "Partial",
          "None"
        ]
      },
      {
        "id": "lastRenovation",
        "label": "Last major renovation",
        "type": "date",
        "group": "maintenance"
      }
    ],
    "commercial:retail": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "gla",
        "label": "Gross leasable area",
        "type": "number",
        "unit": "sqft",
        "group": "physical",
        "required": true
      },
      {
        "id": "storefrontCount",
        "label": "Storefronts",
        "type": "number",
        "group": "physical"
      },
      {
        "id": "anchorTenant",
        "label": "Anchor tenant",
        "type": "text",
        "group": "occupancy"
      },
      {
        "id": "parkingSpaces",
        "label": "Parking spaces",
        "type": "number",
        "group": "physical"
      }
    ],
    "commercial:hospitality": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "roomCount",
        "label": "Guest rooms",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "brandAffiliation",
        "label": "Brand affiliation",
        "type": "text",
        "group": "identity"
      },
      {
        "id": "aaaRating",
        "label": "AAA / Forbes rating",
        "type": "select",
        "group": "compliance",
        "options": [
          "Unrated",
          "1 Diamond",
          "2 Diamond",
          "3 Diamond",
          "4 Diamond",
          "5 Diamond"
        ]
      },
      {
        "id": "lastRenovation",
        "label": "Last major renovation",
        "type": "date",
        "group": "maintenance"
      }
    ],
    "commercial:industrial": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "sqft",
        "label": "Building area",
        "type": "number",
        "unit": "sqft",
        "group": "physical",
        "required": true
      },
      {
        "id": "clearHeight",
        "label": "Clear height",
        "type": "number",
        "unit": "ft",
        "group": "physical"
      },
      {
        "id": "dockCount",
        "label": "Loading docks",
        "type": "number",
        "group": "physical"
      },
      {
        "id": "powerCapacity",
        "label": "Power capacity",
        "type": "number",
        "unit": "amps",
        "group": "utilities"
      },
      {
        "id": "railSpur",
        "label": "Rail spur",
        "type": "select",
        "group": "utilities",
        "options": [
          "None",
          "Active",
          "Removed"
        ]
      }
    ],
    "commercial:institutional": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "sqft",
        "label": "Building area",
        "type": "number",
        "unit": "sqft",
        "group": "physical",
        "required": true
      },
      {
        "id": "occupancyType",
        "label": "Occupancy type",
        "type": "select",
        "group": "compliance",
        "options": [
          "E (Educational)",
          "I-1 (Custodial care)",
          "I-2 (Medical)",
          "I-3 (Detention)",
          "I-4 (Day care)"
        ]
      },
      {
        "id": "sprinklered",
        "label": "Sprinklered",
        "type": "select",
        "group": "compliance",
        "options": [
          "Full",
          "Partial",
          "None"
        ]
      }
    ],
    "commercial:mixed-use": [
      {
        "id": "yearBuilt",
        "label": "Year built",
        "type": "number",
        "group": "identity",
        "required": true
      },
      {
        "id": "residentialUnits",
        "label": "Residential units",
        "type": "number",
        "group": "identity"
      },
      {
        "id": "commercialSqft",
        "label": "Commercial sq ft",
        "type": "number",
        "unit": "sqft",
        "group": "identity"
      }
    ]
  }
} as const;
