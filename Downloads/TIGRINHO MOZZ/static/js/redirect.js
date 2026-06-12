// This script captures clicks on interactive elements (like buttons) and redirects to the VSL page.
document.addEventListener("DOMContentLoaded", () => {
    // Wait a bit to ensure React has fully rendered the DOM and attached its listeners
    setTimeout(() => {
        const buttons = document.querySelectorAll("button, a, .clickable, [role='button']");
        
        buttons.forEach(btn => {
            btn.addEventListener("click", (e) => {
                // Prevent the default React or anchor behavior
                e.preventDefault();
                e.stopPropagation();
                // Redirect to the VSL page
                window.location.href = "/vsl";
            }, true); // Use capture phase to intercept before React synthetic events
        });
        
        console.log("VSL Redirect script attached to", buttons.length, "elements.");
    }, 1500); // 1.5 seconds should be enough for the initial render
});
