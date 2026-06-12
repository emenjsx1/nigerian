import asyncio
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup
import os
import requests
from urllib.parse import urljoin, urlparse

# Directories setup
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

os.makedirs(os.path.join(STATIC_DIR, "css"), exist_ok=True)
os.makedirs(os.path.join(STATIC_DIR, "images"), exist_ok=True)
os.makedirs(os.path.join(STATIC_DIR, "js"), exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

async def scrape_site(url):
    print(f"Starting to clone {url}...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Go to the site and wait for React to fully render the DOM
        print("Waiting for page to render...")
        await page.goto(url, wait_until="networkidle")
        
        # Give it a couple more seconds for any fade-in animations
        await page.wait_for_timeout(3000)
        
        # Remove any scripts that might break our static clone (e.g. lovable badges, react scripts)
        # But maybe we keep them? Actually, since we want static HTML, we can remove the Vite script tag.
        # It's better to let BeautifulSoup handle it.
        
        html_content = await page.content()
        await browser.close()
        
        print("Page fetched. Processing HTML...")
        soup = BeautifulSoup(html_content, "html.parser")
        
        # Remove React bundle script to freeze the page state
        for script in soup.find_all("script"):
            if script.get("src") and ("index-" in script.get("src") or "lovable" in script.get("src")):
                script.decompose()

        # Download and replace CSS
        for link in soup.find_all("link", rel="stylesheet"):
            css_url = link.get("href")
            if css_url:
                css_url = urljoin(url, css_url)
                filename = os.path.basename(urlparse(css_url).path)
                if not filename.endswith(".css"): filename += ".css"
                local_path = os.path.join("css", filename)
                
                print(f"Downloading CSS: {css_url}")
                try:
                    css_resp = requests.get(css_url)
                    with open(os.path.join(STATIC_DIR, local_path), "wb") as f:
                        f.write(css_resp.content)
                    link["href"] = f"{{{{ url_for('static', filename='{local_path.replace(os.sep, '/')}') }}}}"
                except Exception as e:
                    print(f"Failed to download CSS: {e}")

        # Download and replace Images
        for img in soup.find_all("img"):
            img_url = img.get("src")
            if img_url and not img_url.startswith("data:"):
                img_url = urljoin(url, img_url)
                filename = os.path.basename(urlparse(img_url).path)
                if not filename: filename = "image.png"
                local_path = os.path.join("images", filename)
                
                print(f"Downloading Image: {img_url}")
                try:
                    img_resp = requests.get(img_url)
                    with open(os.path.join(STATIC_DIR, local_path), "wb") as f:
                        f.write(img_resp.content)
                    img["src"] = f"{{{{ url_for('static', filename='{local_path.replace(os.sep, '/')}') }}}}"
                except Exception as e:
                    print(f"Failed to download image: {e}")
                    
        # Replace inline styles background images if they have URLs
        # (A full scraper handles this, but we'll stick to img tags for now. If needed, we'll do inline styles too).

        # Add the VSL redirect script to the head
        redirect_script = soup.new_tag("script", src="{{ url_for('static', filename='js/redirect.js') }}")
        if soup.head:
            soup.head.append(redirect_script)

        # Save the final HTML
        final_html_path = os.path.join(TEMPLATES_DIR, "index.html")
        with open(final_html_path, "w", encoding="utf-8") as f:
            f.write(soup.prettify())
            
        print("Clone complete! HTML saved to templates/index.html")

if __name__ == "__main__":
    asyncio.run(scrape_site("https://tiger-fortune-landing.lovable.app/"))
