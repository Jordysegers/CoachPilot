# Coachpilot

De app voor touringcarchauffeurs: busparkings met voorzieningen en reviews, hotels in de buurt op de kaart, en een open community met meldingen en moderatie.

## Hoe het in elkaar zit
- `index.html` – de hele app (één pagina).
- `config.js` – adres en publieke sleutel van Supabase.
- `supabase/schema.sql` – database, beveiligingsregels en foto-opslag. Eén keer uitvoeren in Supabase > SQL Editor (mag vaker).
- Hosting: Vercel. Elke wijziging op `main` gaat automatisch live.

## Moderator maken
Registreer in de app en voer daarna in de Supabase SQL Editor uit:

```sql
insert into public.moderators (user_id)
select id from auth.users where email = 'JOUW@EMAIL.NL'
on conflict do nothing;
```

## Nog te doen voor een publieke lancering
- De 17 voorbeeld-busparkings vervangen door echte (via "Parking doorgeven" of de moderatie).
- Hotels: echte prijzen en beschikbaarheid via het Booking.com-partnerprogramma (nu voorbeelddata).
- Kaart: Google Maps of Mapbox in plaats van de getekende kaart.
