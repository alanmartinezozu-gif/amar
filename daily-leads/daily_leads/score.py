"""Step 4: score 0-10 and rank."""

from __future__ import annotations

from .models import Lead


def score_lead(lead: Lead) -> int:
    score = 0
    score += 3 if lead.spanish_signal else 0
    score += 2 if lead.lead_platforms else 0
    score += 2 if lead.emergency_service else 0
    score += 2 if lead.has_contact_form else 0
    score += 1 if 20 <= lead.reviews <= 200 else 0
    return score


def rank(leads: list[Lead]) -> list[Lead]:
    """Highest score first; ties go to leads we can reach by name, then better ratings."""
    for lead in leads:
        lead.score = score_lead(lead)
    return sorted(leads, key=lambda l: (-l.score, not l.owner_name, -(l.rating or 0), -l.reviews, l.name.lower()))
